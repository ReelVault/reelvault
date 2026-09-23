import type { DiscoverResponse } from "@sdk/common/discover.types";
import { BaseResource } from "../core/base-client";

export class DiscoverClient extends BaseResource {
	getDiscoverView(query: { limit?: number } = {}): Promise<DiscoverResponse> {
		return this._get("/discover", { query });
	}
}
