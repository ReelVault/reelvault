import type { MetadataImageOption } from "@sdk/common";
import { createHash } from "./crypto.utils";
import { MemoryCache } from "./memory-cache";
import { PathUtils } from "./path.utils";
import { normalizeLower } from "./type.utils";

export function normalizeComponent(value: string): string {
	return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

// Native Buffer hex codec — faster than a manual TextEncoder/byte-array/join loop.
export function encodeComponent(value: string): string {
	return Buffer.from(normalizeComponent(value), "utf8").toString("hex");
}

function decodeComponent(hex: string): string {
	try {
		return Buffer.from(hex, "hex").toString("utf8");
	} catch {
		return hex;
	}
}

export function createImageStableKey({
	ownerStableKey,
	imageType,
	sourceHash,
}: {
	ownerStableKey: string;
	imageType: string;
	sourceHash: string;
}): string {
	return ["v1", "local", encodeComponent("image"), encodeComponent(`${ownerStableKey}:${imageType}:${sourceHash}`)].join(":");
}

// Ordered by specificity: "avatar" must match before "profile" (people portraits).
const IMAGE_TYPE_FOLDER_MAP: ReadonlyArray<readonly [readonly string[], string]> = [
	[["poster"], "posters"],
	[["backdrop", "background", "fanart"], "backdrops"],
	[["avatar"], "profiles"],
	[["person", "profile", "actor"], "people"],
];

function getSubfolderForImageType(imageType?: string): string {
	if (!imageType) return "others";

	const lower = normalizeLower(imageType);
	for (const [keywords, folder] of IMAGE_TYPE_FOLDER_MAP) {
		if (keywords.some((kw) => lower.includes(kw))) return folder;
	}

	return "others";
}

// Hashing the same stableKey repeatedly (retries, refreshes) is wasted work —
// memoize the pure stableKey→path mapping.
const storagePathCache = new MemoryCache<string>({ ttlMs: -1, maxSize: 2000, name: "image-storage-path" });

export function createImageStoragePath({
	root,
	stableKey,
	imageType,
}: {
	root: string;
	stableKey: string;
	imageType?: string | undefined;
}): string {
	const cacheKey = `${root}|${imageType ?? ""}|${stableKey}`;
	const cached = storagePathCache.get(cacheKey);
	if (cached) return cached;

	let resolvedType = imageType;
	if (!resolvedType && stableKey.includes(":")) {
		const parts = stableKey.split(":");
		if (parts.length >= 4 && parts[3]) {
			const decoded = decodeComponent(parts[3]);
			const segments = decoded.split(":");
			if (segments.length >= 2 && segments[1]) {
				resolvedType = segments[1];
			}
		}
	}

	const subfolder = getSubfolderForImageType(resolvedType);
	const fileKey = createHash("sha256").update(stableKey).digest("hex");
	const path = PathUtils.join(root, subfolder, `${fileKey}.webp`);

	storagePathCache.set(cacheKey, path);

	return path;
}

/**
 * Stable sort by provider score, best first. `Array.prototype.sort` is stable,
 * so equal and missing scores preserve the provider's own ordering.
 */
export function rankImageOptions(options: MetadataImageOption[]): MetadataImageOption[] {
	return [...options].toSorted((left, right) => (right.score ?? Number.NEGATIVE_INFINITY) - (left.score ?? Number.NEGATIVE_INFINITY));
}
