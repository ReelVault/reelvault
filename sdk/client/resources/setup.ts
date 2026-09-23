import type { RegisterResponse, SetupAdminRequest, SetupStatus } from "@sdk/common";

import { BaseResource } from "../core/base-client";

export class SetupClient extends BaseResource {
	getStatus(): Promise<SetupStatus> {
		return this._get("/setup/status");
	}

	createAdmin(body: SetupAdminRequest, setupToken?: string): Promise<RegisterResponse> {
		return this._post("/setup", {
			body,
			headers: setupToken ? { "x-setup-token": setupToken } : undefined,
		});
	}
}
