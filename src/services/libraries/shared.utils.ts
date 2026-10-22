import { file as bunFile } from "bun";
import { DomainError } from "@/utils/domain.errors";
import { LANGUAGE_TAG_PATTERN } from "@/utils/language.utils";

/** Routes whose cached bodies list libraries — invalidated on library mutations. */
export const LIBRARY_LIST_PATH_PREFIXES = ["/v1/libraries"] as const;

/** Whether a configured path can be stat-ed right now (`exists` means the stat succeeded), and whether it is a directory. */
export async function describePath(path: string): Promise<{ exists: boolean; isDirectory: boolean }> {
	try {
		return { exists: true, isDirectory: (await bunFile(path).stat()).isDirectory() };
	} catch {
		return { exists: false, isDirectory: false };
	}
}

/**
 * Server-owned normalization for the per-library metadata language override:
 * `null`/empty clears it, otherwise an ISO language tag is required.
 * `undefined` (field absent) keeps the stored value untouched on updates.
 */
export function normalizeMetadataLanguage(value: string | null | undefined): string | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;

	const trimmed = value.trim();
	if (!trimmed) return null;

	if (!LANGUAGE_TAG_PATTERN.test(trimmed)) {
		throw new DomainError("validation", "metadataLanguage must be an ISO language code like 'pl' or 'en-US'", {
			code: "library.invalid_metadata_language",
		});
	}

	return trimmed;
}
