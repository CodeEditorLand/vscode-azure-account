/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as FormData from 'form-data';
import { ReadStream } from 'fs';
import { ClientRequest } from 'http';
import { DeviceTokenCredentials } from 'ms-rest-azure';
import { Socket } from 'net';
import fetch, { Response } from 'node-fetch';
import * as path from 'path';
import * as semver from 'semver';
import { parse, UrlWithStringQuery } from 'url';
import { v4 as uuid } from 'uuid';
import { commands, Disposable, env, EventEmitter, MessageItem, QuickPickItem, Terminal, Uri, window } from 'vscode';
import { AzureAccountExtensionApi, AzureLoginStatus, AzureSession, CloudShell, CloudShellStatus, UploadOptions } from '../azure-account.api';
import { AzureSession as AzureSessionLegacy } from '../azure-account.legacy.api';
import { ext } from '../extensionVariables';
import { tokenFromRefreshToken } from '../login/adal/tokens';
import { TelemetryReporter } from '../telemetry';
import { localize } from '../utils/localize';
import { Deferred } from '../utils/promiseUtils';
import { AccessTokens, connectTerminal, ConsoleUris, Errors, getUserSettings, provisionConsole, resetConsole, Size, UserSettings } from './cloudConsoleLauncher';
import { createServer, Queue, readJSON, Server } from './ipc';



interface OS {
	id: 'linux' | 'windows';
	shellName: string;
	otherOS: OS;
}

export type OSName = 'Linux' | 'Windows';

type OSes = { Linux: OS, Windows: OS };

interface CloudShellWritable extends CloudShell {
	status: CloudShellStatus
}

export const OSes: OSes = {
	Linux: {
		id: 'linux',
		shellName: localize('azure-account.bash', "Bash"),
		// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
		get otherOS(): OS { return OSes.Windows; },
	},
	Windows: {
		id: 'windows',
		shellName: localize('azure-account.powershell', "PowerShell"),
		// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
		get otherOS(): OS { return OSes.Linux; },
	}
};

function sendTelemetryEvent(reporter: TelemetryReporter, outcome: string, message?: string) {
	/* __GDPR__
	   "openCloudConsole" : {
		  "outcome" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
		  "message": { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth" }
	   }
	 */

	reporter.sendSanitizedEvent('openCloudConsole', message ? { outcome, message } : { outcome });
}

async function waitForConnection(this: CloudShell): Promise<boolean> {
	const handleStatus = () => {
		switch (this.status) {
			case 'Connecting':
				return new Promise<boolean>(resolve => {
					const subs = this.onStatusChanged(() => {
						subs.dispose();
						resolve(handleStatus());
					});
				});
			case 'Connected':
				return true;
			case 'Disconnected':
				return false;
			default:
				const status: never = this.status;
				throw new Error(`Unexpected status '${status}'`);
		}
	};
	return handleStatus();
}

function getUploadFile(tokens: Promise<AccessTokens>, uris: Promise<ConsoleUris>): (this: CloudShell, filename: string, stream: ReadStream, options?: UploadOptions) => Promise<void> {
	return async function (this: CloudShell, filename: string, stream: ReadStream, options: UploadOptions = {}) {
		if (options.progress) {
			options.progress.report({ message: localize('azure-account.connectingForUpload', "Connecting to upload '{0}'...", filename) });
		}

		const accessTokens: AccessTokens = await tokens;
		const { terminalUri } = await uris;

		if (options.token && options.token.isCancellationRequested) {
			throw 'canceled';
		}

		return new Promise<void>((resolve, reject) => {
			const form = new FormData();
			form.append('uploading-file', stream, {
				filename,
				knownLength: options.contentLength
			});
			const uri: UrlWithStringQuery = parse(`${terminalUri}/upload`);
			const req: ClientRequest = form.submit(
				{
					// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
					protocol: <any>uri.protocol,
					hostname: uri.hostname,
					port: uri.port,
					path: uri.path,
					headers: {
						'Authorization': `Bearer ${accessTokens.resource}`
					},
				},
				(err, res) => {
					if (err) {
						reject(err);
					} if (res && res.statusCode && (res.statusCode < 200 || res.statusCode > 299)) {
						reject(`${res.statusMessage} (${res.statusCode})`)
					} else {
						resolve();
					}
					if (res) {
						res.resume(); // Consume response.
					}
				}
			);

			if (options.token) {
				options.token.onCancellationRequested(() => {
					reject('canceled');
					req.abort();
				});
			}
			if (options.progress) {
				req.on('socket', (socket: Socket) => {
					// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
					options.progress!.report({
						message: localize('azure-account.uploading', "Uploading '{0}'...", filename),
						increment: 0
					});

					let previous: number = 0;
					socket.on('drain', () => {
						const total: number = req.getHeader('Content-Length') as number;
						if (total) {
							const worked: number = Math.min(Math.round(100 * socket.bytesWritten / total), 100);
							const increment: number = worked - previous;
							if (increment) {
								// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
								options.progress!.report({
									message: localize('azure-account.uploading', "Uploading '{0}'...", filename),
									increment
								});
							}
							previous = worked;
						}
					});
				});
			}
		});
	}
}

export const shells: CloudShell[] = [];
export function createCloudConsole(api: AzureAccountExtensionApi, reporter: TelemetryReporter, osName: OSName): CloudShell {
	const os: OS = OSes[osName];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let liveServerQueue: Queue<any> | undefined;
	const event: EventEmitter<CloudShellStatus> = new EventEmitter<CloudShellStatus>();
	let deferredTerminal: Deferred<Terminal>;
	let deferredSession: Deferred<AzureSession>;
	let deferredTokens: Deferred<AccessTokens>;
	const tokensPromise: Promise<AccessTokens> = new Promise<AccessTokens>((resolve, reject) => deferredTokens = { resolve, reject });
	let deferredUris: Deferred<ConsoleUris>;
	const urisPromise: Promise<ConsoleUris> = new Promise<ConsoleUris>((resolve, reject) => deferredUris = { resolve, reject });
	let deferredInitialSize: Deferred<Size>;
	const initialSizePromise: Promise<Size> = new Promise<Size>((resolve, reject) => deferredInitialSize = { resolve, reject });
	const state: CloudShellWritable = {
		status: 'Connecting',
		onStatusChanged: event.event,
		waitForConnection,
		terminal: new Promise<Terminal>((resolve, reject) => deferredTerminal = { resolve, reject }),
		session: new Promise<AzureSession>((resolve, reject) => deferredSession = { resolve, reject }),
		uploadFile: getUploadFile(tokensPromise, urisPromise)
	};

	// eslint-disable-next-line @typescript-eslint/no-empty-function
	state.terminal.catch(() => { }); // ignore
	// eslint-disable-next-line @typescript-eslint/no-empty-function
	state.session.catch(() => { }); // ignore
	shells.push(state);

	function updateStatus(status: CloudShellStatus) {
		state.status = status;
		event.fire(state.status);
		if (status === 'Disconnected') {
			deferredTerminal.reject(status);
			deferredSession.reject(status);
			deferredTokens.reject(status);
			deferredUris.reject(status);
			shells.splice(shells.indexOf(state), 1);
			void commands.executeCommand('setContext', 'openCloudConsoleCount', `${shells.length}`);
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(async function (): Promise<any> {
		void commands.executeCommand('setContext', 'openCloudConsoleCount', `${shells.length}`);

		const isWindows: boolean = process.platform === 'win32';
		if (isWindows) {
			// See below
			try {
				const { stdout } = await exec('node.exe --version');
				const version: string | boolean = stdout[0] === 'v' && stdout.substr(1).trim();
				if (version && semver.valid(version) && !semver.gte(version, '6.0.0')) {
					updateStatus('Disconnected');
					return requiresNode(reporter);
				}
			} catch (err) {
				updateStatus('Disconnected');
				return requiresNode(reporter);
			}
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const serverQueue: Queue<any> = new Queue<any>();
		// eslint-disable-next-line @typescript-eslint/no-misused-promises
		const server: Server = await createServer('vscode-cloud-console', async (req, res) => {
			let dequeue: boolean = false;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			for (const message of await readJSON<any>(req)) {
				/* eslint-disable @typescript-eslint/no-unsafe-member-access */
				if (message.type === 'poll') {
					dequeue = true;
				} else if (message.type === 'log') {
					console.log(...message.args);
				} else if (message.type === 'size') {
					deferredInitialSize.resolve(message.size);
				} else if (message.type === 'status') {
					updateStatus(message.status);
				}
				/* eslint-enable @typescript-eslint/no-unsafe-member-access */
			}

			let response = [];
			if (dequeue) {
				try {
					response = await serverQueue.dequeue(60000);
				} catch (err) {
					// ignore timeout
				}
			}
			res.write(JSON.stringify(response));
			res.end();
		});

		// open terminal
		let shellPath: string = path.join(ext.context.asAbsolutePath('bin'), `node.${isWindows ? 'bat' : 'sh'}`);
		let modulePath: string = path.join(ext.context.asAbsolutePath('dist'), 'cloudConsoleLauncher');
		if (isWindows) {
			modulePath = modulePath.replace(/\\/g, '\\\\');
		}
		const shellArgs: string[] = [
			process.argv0,
			'-e',
			`require('${modulePath}').main()`,
		];

		if (isWindows) {
			// Work around https://github.com/electron/electron/issues/4218 https://github.com/nodejs/node/issues/11656
			shellPath = 'node.exe';
			shellArgs.shift();
		}

		const terminal: Terminal = window.createTerminal({
			name: localize('azure-account.cloudConsole', "{0} in Cloud Shell", os.shellName),
			shellPath,
			shellArgs,
			env: {
				CLOUD_CONSOLE_IPC: server.ipcHandlePath,
			}
		});
		const subscription: Disposable = window.onDidCloseTerminal(t => {
			if (t === terminal) {
				liveServerQueue = undefined;
				subscription.dispose();
				server.dispose();
				updateStatus('Disconnected');
			}
		});
		liveServerQueue = serverQueue;
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		deferredTerminal!.resolve(terminal);

		const loginStatus: AzureLoginStatus = await waitForLoginStatus(api);
		if (loginStatus !== 'LoggedIn') {
			if (loginStatus === 'LoggingIn') {
				serverQueue.push({ type: 'log', args: [localize('azure-account.loggingIn', "Signing in...")] });
			}
			if (!(await api.waitForLogin())) {
				serverQueue.push({ type: 'log', args: [localize('azure-account.loginNeeded', "Sign in needed.")] });
				sendTelemetryEvent(reporter, 'requiresLogin');
				await commands.executeCommand('azure-account.askForLogin');
				if (!(await api.waitForLogin())) {
					serverQueue.push({ type: 'exit' });
					updateStatus('Disconnected');
					return;
				}
			}
		}

		let token: Token | undefined = undefined;
		await api.waitForSubscriptions();
		const sessions: AzureSession[] = [...new Set(api.subscriptions.map(subscription => subscription.session))]; // Only consider those with at least one subscription.
		if (sessions.length > 1) {
			serverQueue.push({ type: 'log', args: [localize('azure-account.selectDirectory', "Select directory...")] });

			const fetchingDetails: Promise<({
				session: AzureSession;
				tenantDetails: TenantDetails;
			} | undefined)[]> = Promise.all(sessions.map(session => fetchTenantDetails(<AzureSession>session)
				.catch(err => {
					console.error(err);
					return undefined;
				})))
				.then(tenantDetails => tenantDetails.filter(details => details));

			const pick = await window.showQuickPick<QuickPickItem & { session: AzureSession }>(fetchingDetails
				.then(tenantDetails => tenantDetails.map(details => {
					// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
					const tenantDetails: TenantDetails = details!.tenantDetails;
					const defaultDomainName: string | undefined = (tenantDetails.verifiedDomains.find(domain => domain.default))?.name;
					return {
						label: tenantDetails.displayName,
						description: defaultDomainName,
						// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
						session: details!.session
					};
				}).sort((a, b) => a.label.localeCompare(b.label))), {
					placeHolder: localize('azure-account.selectDirectoryPlaceholder', "Select directory"),
					ignoreFocusOut: true // The terminal opens concurrently and can steal focus (https://github.com/microsoft/vscode-azure-account/issues/77).
				});
			if (!pick) {
				sendTelemetryEvent(reporter, 'noTenantPicked');
				serverQueue.push({ type: 'exit' });
				updateStatus('Disconnected');
				return;
			}
			token = await acquireToken(pick.session);
		} else if (sessions.length === 1) {
			token = await acquireToken(<AzureSession>sessions[0]);
		}

		const result = token && await findUserSettings(token);
		if (!result) {
			serverQueue.push({ type: 'log', args: [localize('azure-account.setupNeeded', "Setup needed.")] });
			await requiresSetUp(reporter);
			serverQueue.push({ type: 'exit' });
			updateStatus('Disconnected');
			return;
		}
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		deferredSession!.resolve(result.token.session);

		// provision
		let consoleUri: string;
		const session: AzureSession = result.token.session;
		const accessToken: string = result.token.accessToken;
		const armEndpoint: string = session.environment.resourceManagerEndpointUrl;
		const provisionTask: () => Promise<void> = async () => {
			consoleUri = await provisionConsole(accessToken, armEndpoint, result.userSettings, OSes.Linux.id);
			sendTelemetryEvent(reporter, 'provisioned');
		}
		try {
			serverQueue.push({ type: 'log', args: [localize('azure-account.requestingCloudConsole', "Requesting a Cloud Shell...")] });
			await provisionTask();
		} catch (err) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
			if (err && err.message === Errors.DeploymentOsTypeConflict) {
				const reset: boolean = await deploymentConflict(reporter, os);
				if (reset) {
					await resetConsole(accessToken, armEndpoint);
					return provisionTask();
				} else {
					serverQueue.push({ type: 'exit' });
					updateStatus('Disconnected');
					return;
				}
			} else {
				throw err;
			}
		}

		// Additional tokens
		const [graphToken, keyVaultToken] = await Promise.all([
			tokenFromRefreshToken(session.environment, result.token.refreshToken, session.tenantId, session.environment.activeDirectoryGraphResourceId),
			session.environment.keyVaultDnsSuffix
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				? tokenFromRefreshToken(session.environment, result.token.refreshToken, session.tenantId, `https://${session.environment.keyVaultDnsSuffix!.substr(1)}`)
				: Promise.resolve(undefined)
		]);
		const accessTokens: AccessTokens = {
			resource: accessToken,
			graph: graphToken.accessToken,
			keyVault: keyVaultToken && keyVaultToken.accessToken
		};
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		deferredTokens!.resolve(accessTokens);

		// Connect to terminal
		const connecting: string = localize('azure-account.connectingTerminal', "Connecting terminal...");
		serverQueue.push({ type: 'log', args: [connecting] });
		const progressTask: (i: number) => void = (i: number) => {
			serverQueue.push({ type: 'log', args: [`\x1b[A${connecting}${'.'.repeat(i)}`] });
		};
		const initialSize: Size = await initialSizePromise;
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		const consoleUris: ConsoleUris = await connectTerminal(accessTokens, consoleUri!, /* TODO: Separate Shell from OS */ osName === 'Linux' ? 'bash' : 'pwsh', initialSize, progressTask);
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		deferredUris!.resolve(consoleUris);

		// Connect to WebSocket
		serverQueue.push({
			type: 'connect',
			accessTokens,
			consoleUris
		});
	})().catch(err => {
		/* eslint-disable @typescript-eslint/no-unsafe-member-access */
		console.error(err && err.stack || err);
		updateStatus('Disconnected');
		sendTelemetryEvent(reporter, 'error', String(err && err.message || err));
		if (liveServerQueue) {
			liveServerQueue.push({ type: 'log', args: [localize('azure-account.error', "Error: {0}", String(err && err.message || err))] });
		}
		/* eslint-enable @typescript-eslint/no-unsafe-member-access */
	});
	return state;
}

async function waitForLoginStatus(api: AzureAccountExtensionApi): Promise<AzureLoginStatus> {
	if (api.status !== 'Initializing') {
		return api.status;
	}
	return new Promise<AzureLoginStatus>(resolve => {
		const subscription: Disposable = api.onStatusChanged(() => {
			subscription.dispose();
			resolve(waitForLoginStatus(api));
		});
	});
}

async function findUserSettings(token: Token): Promise<{ userSettings: UserSettings; token: Token; } | undefined> {
	const userSettings: UserSettings | undefined = await getUserSettings(token.accessToken, token.session.environment.resourceManagerEndpointUrl);
	if (userSettings && userSettings.storageProfile) {
		return { userSettings, token };
	}
}

async function requiresSetUp(reporter: TelemetryReporter): Promise<void> {
	sendTelemetryEvent(reporter, 'requiresSetUp');
	const open: MessageItem = { title: localize('azure-account.open', "Open") };
	const message: string = localize('azure-account.setUpInWeb', "First launch of Cloud Shell in a directory requires setup in the web application (https://shell.azure.com).");
	const response: MessageItem | undefined = await window.showInformationMessage(message, open);
	if (response === open) {
		sendTelemetryEvent(reporter, 'requiresSetUpOpen');
		void env.openExternal(Uri.parse('https://shell.azure.com'));
	} else {
		sendTelemetryEvent(reporter, 'requiresSetUpCancel');
	}
}

async function requiresNode(reporter: TelemetryReporter): Promise<void> {
	sendTelemetryEvent(reporter, 'requiresNode');
	const open: MessageItem = { title: localize('azure-account.open', "Open") };
	const message: string = localize('azure-account.requiresNode', "Opening a Cloud Shell currently requires Node.js 6 or later to be installed (https://nodejs.org).");
	const response: MessageItem | undefined = await window.showInformationMessage(message, open);
	if (response === open) {
		sendTelemetryEvent(reporter, 'requiresNodeOpen');
		void env.openExternal(Uri.parse('https://nodejs.org'));
	} else {
		sendTelemetryEvent(reporter, 'requiresNodeCancel');
	}
}

async function deploymentConflict(reporter: TelemetryReporter, os: OS): Promise<boolean> {
	sendTelemetryEvent(reporter, 'deploymentConflict');
	const ok: MessageItem = { title: localize('azure-account.ok', "OK") };
	const message: string = localize('azure-account.deploymentConflict', "Starting a {0} session will terminate all active {1} sessions. Any running processes in active {1} sessions will be terminated.", os.shellName, os.otherOS.shellName);
	const response: MessageItem | undefined = await window.showWarningMessage(message, ok);
	const reset: boolean = response === ok;
	sendTelemetryEvent(reporter, reset ? 'deploymentConflictReset' : 'deploymentConflictCancel');
	return reset;
}

interface Token {
	session: AzureSession;
	accessToken: string;
	refreshToken: string;
}

async function acquireToken(session: AzureSession): Promise<Token> {
	return new Promise<Token>((resolve, reject) => {
		/* eslint-disable @typescript-eslint/no-explicit-any */
		const credentials: any = (<AzureSessionLegacy>session).credentials;
		const environment: any = session.environment;
		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
		credentials.context.acquireToken(environment.activeDirectoryResourceId, credentials.username, credentials.clientId, function (err: any, result: any) {
		/* eslint-enable @typescript-eslint/no-explicit-any */
			if (err) {
				reject(err);
			} else {
				resolve({
					session,
					// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
					accessToken: result.accessToken,
					// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
					refreshToken: result.refreshToken
				});
			}
		});
	});
}

interface TenantDetails {
	objectId: string;
	displayName: string;
	verifiedDomains: { name: string; default: boolean; }[];
}

async function fetchTenantDetails(session: AzureSession): Promise<{ session: AzureSession, tenantDetails: TenantDetails }> {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
	const { username, clientId, tokenCache, domain } = <any>(<AzureSessionLegacy>session).credentials;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
	const graphCredentials: DeviceTokenCredentials = new DeviceTokenCredentials({ username, clientId, tokenCache, domain, tokenAudience: 'graph' });

	const apiVersion: string = '1.6';
	const requestUrl: string = `https://graph.windows.net/${encodeURIComponent(session.tenantId)}/tenantDetails?api-version=${encodeURIComponent(apiVersion)}`;

	return new Promise((resolve, reject) => {
		// eslint-disable-next-line @typescript-eslint/no-misused-promises, @typescript-eslint/no-explicit-any
		graphCredentials.getToken(async (err: Error, result: any) => {
			if (err) {
				reject(err);
				return;
			}

			if (result) {
				try {
					const response: Response = await fetch(requestUrl, {
						headers: {
							// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
							Authorization: `Bearer ${result.accessToken}`,
							"x-ms-client-request-id": uuid(),
							"Content-Type": 'application/json; charset=utf-8'
						}
					});

					if (response.ok) {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
						const json = await response.json();
						resolve({
							session,
							// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
							tenantDetails: json.value[0]
						});
					} else {
						reject(response.statusText)
					}
				} catch (e) {
					reject(e);
				}
			}
		});
	});
}

export interface ExecResult {
	error: Error | null;
	stdout: string;
	stderr: string;
}


async function exec(command: string): Promise<ExecResult> {
	return new Promise<ExecResult>((resolve, reject) => {
		cp.exec(command, (error, stdout, stderr) => {
			(error || stderr ? reject : resolve)({ error, stdout, stderr });
		});
	});
}