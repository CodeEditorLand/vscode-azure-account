/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Terminal, TerminalProfile } from "vscode";
import type { CloudShell, CloudShellStatus } from "../azure-account.api";

export interface CloudShellInternal extends Omit<CloudShell, "terminal"> {
	status: CloudShellStatus;
	terminal?: Promise<Terminal>;
	terminalProfile?: Promise<TerminalProfile>;
}
