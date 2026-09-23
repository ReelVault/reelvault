import type {
	CreateSubtitleRequest,
	Subtitle,
	SubtitleFilters,
	SubtitleProviderDownloadRequest,
	SubtitleProviderSearchRequest,
	SubtitleProviderSearchResponse,
	SubtitleProviderStatus,
	SubtitleSorting,
	UpdateSubtitleRequest,
} from "@sdk/common";

import type { PaginatedResponse, PaginationQuery } from "@sdk/common/pagination";
import { BaseResource } from "../core/base-client";

export class SubtitlesClient extends BaseResource {
	getAll(query?: PaginationQuery & SubtitleFilters & SubtitleSorting): Promise<PaginatedResponse<Subtitle>> {
		return this._get(`/subtitles`, { query });
	}

	create(body: CreateSubtitleRequest): Promise<Subtitle> {
		return this._post(`/subtitles`, { body });
	}

	getById(id: string): Promise<Subtitle> {
		return this._get(`/subtitles/${id}`);
	}

	update(id: string, body: UpdateSubtitleRequest): Promise<Subtitle> {
		return this._patch(`/subtitles/${id}`, { body });
	}

	delete(id: string): Promise<{ success: true }> {
		return this._delete(`/subtitles/${id}`);
	}

	listProviders(): Promise<SubtitleProviderStatus[]> {
		return this._get(`/subtitles/providers`);
	}

	searchProviders(body: SubtitleProviderSearchRequest): Promise<SubtitleProviderSearchResponse[]> {
		return this._post(`/subtitles/search`, { body });
	}

	downloadFromProvider(providerId: string, body: SubtitleProviderDownloadRequest): Promise<Subtitle> {
		return this._post(`/subtitles/providers/${providerId}/download`, { body });
	}

	getContent(id: string): Promise<string> {
		return this._get(`/subtitles/${id}/content`);
	}
}
