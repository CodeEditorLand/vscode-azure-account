/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SubscriptionModels } from "@azure/arm-subscriptions";
import type { AccountInfo } from "@azure/msal-node";
import type { QuickPickItem } from "vscode";
import type { AzureSubscription } from "../azure-account.api";
import type { TenantIdDescription } from "./TenantIdDescription";

export interface ISubscriptionItem extends QuickPickItem {
	subscription: AzureSubscription;
}

export interface SubscriptionTenantCache {
	subscriptions: {
		session: {
			environment: string;
			userId: string;
			tenantId: string;
			accountInfo?: AccountInfo;
		};
		subscription: SubscriptionModels.Subscription;
	}[];
	tenants: TenantIdDescription[];
}
