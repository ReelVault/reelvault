import type { ImageQuery } from "@sdk/common/images";
import { BaseResource } from "../core/base-client";

export class ImagesClient extends BaseResource {
	getById(imageId: string, query?: ImageQuery): Promise<Blob> {
		return this._get<Blob>(`/images/${imageId}`, { query });
	}

	getUrlById(imageId: string, query?: ImageQuery): string {
		const url = new URL(`/v1/images/${imageId}`, this.getBaseUrl());
		if (query) {
			for (const [key, value] of Object.entries(query)) {
				if (value !== undefined) url.searchParams.set(key, String(value));
			}
		}

		return url.toString();
	}

	delete(imageId: string, deleteFile?: boolean): Promise<{ success: boolean }> {
		return this._delete(`/images/${imageId}`, {
			query: deleteFile ? { deleteFile: "true" } : undefined,
		});
	}
}
