import type { HealthStatus } from "@sdk/common";
import { BaseResource } from "../core/base-client";

export class HealthClient extends BaseResource {
	check(): Promise<HealthStatus> {
		return this._get("/health");
	}
}
