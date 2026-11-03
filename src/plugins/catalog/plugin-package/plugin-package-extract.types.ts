import type { DomainErrorCategory, DomainErrorParams } from "@/utils/domain.errors";

/** One extraction request handed to the worker thread. */
export interface PluginPackageExtractRequest {
	archivePath: string;
	workRoot: string;
	maxUncompressedBytes: number;
}

/** Success or a serialized domain error, so the parent can recreate the same code/category. */
export type PluginPackageExtractResponse =
	| { ok: true }
	| {
			ok: false;
			category: DomainErrorCategory;
			code: string;
			message: string;
			params?: DomainErrorParams | undefined;
	  };
