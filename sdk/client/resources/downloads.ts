import type { DownloadJob, MyDownloadsResponse, PrepareDownload } from "@sdk/common";
import { BaseResource } from "../core/base-client";

export class DownloadsClient extends BaseResource {
	list(): Promise<MyDownloadsResponse> {
		return this._get("/downloads");
	}

	prepare(body: PrepareDownload): Promise<DownloadJob> {
		return this._post("/downloads/prepare", { body });
	}

	getStatus(jobId: string): Promise<DownloadJob | null> {
		if (!jobId) return Promise.reject(new Error("jobId is required"));

		return this._get<DownloadJob | null>(`/downloads/${jobId}/status`);
	}

	getFileUrl(jobId: string): string {
		return new URL(`/v1/downloads/${jobId}/file`, this.getBaseUrl()).toString();
	}

	remove(jobId: string): Promise<{ success: boolean }> {
		if (!jobId) return Promise.reject(new Error("jobId is required"));

		return this._delete<{ success: boolean }>(`/downloads/${jobId}`);
	}
}
