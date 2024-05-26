/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Environment } from "@azure/ms-rest-azure-env";
import type { AccountInfo } from "@azure/msal-common";
import type { AzureSession } from "../azure-account.api";
import type {
	AbstractCredentials,
	AbstractCredentials2,
	AuthProviderBase,
} from "./AuthProviderBase";

export class AzureSessionInternal implements AzureSession {
	constructor(
		public environment: Environment,
		public userId: string,
		public tenantId: string,
		public accountInfo: AccountInfo | undefined,
		private _authProvider: AuthProviderBase<unknown>,
	) {}

	public get credentials(): AbstractCredentials {
		return this._authProvider.getCredentials(
			this.environment.name,
			this.userId,
			this.tenantId,
		);
	}

	public get credentials2(): AbstractCredentials2 {
		return this._authProvider.getCredentials2(
			this.environment,
			this.userId,
			this.tenantId,
			this.accountInfo,
		);
	}
}
