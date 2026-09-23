import type {
	MetadataProviderConfiguration,
	MetadataProviderSearchRequest,
	MetadataProviderSearchResponse,
	MetadataProviderStatus,
} from "@sdk/common";

import { BaseResource } from "../core/base-client";

export class ProvidersClient extends BaseResource {
	list(): Promise<MetadataProviderStatus[]> {
		return this._get("/providers");
	}

	getConfigurations(): Promise<MetadataProviderConfiguration[]> {
		return this._get("/providers/configurations");
	}

	search(body: MetadataProviderSearchRequest): Promise<MetadataProviderSearchResponse[]> {
		return this._post("/providers/search", { body });
	}
}
