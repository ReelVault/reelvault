import type { ProviderEntityType } from "@reelvault/sdk/common";
import { encodeComponent, normalizeComponent } from "@/utils/image-storage.utils";

const STABLE_KEY_VERSION = "v1";

/** RFC 4122 URL namespace that provider person ids are name-based (v5) UUIDs under. Persisted, so the value must not change. */
const PROVIDER_PERSON_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/** Stable id of a provider-supplied person. Trimmed like the provider keys, so padded input maps to the same person. */
export function createProviderPersonId(providerName: string, externalId: string): string {
	return Bun.randomUUIDv5(`${providerName.trim()}:${externalId.trim()}`, PROVIDER_PERSON_NAMESPACE);
}

/** Builds a versioned, delimiter-safe identity for an entity supplied by a provider. */
export function createProviderStableKey({
	providerName,
	entityType,
	externalId,
}: {
	providerName: string;
	entityType: ProviderEntityType;
	externalId: string;
}): string {
	return [STABLE_KEY_VERSION, "provider", entityType, encodeComponent(providerName), encodeComponent(externalId)].join(":");
}

export function createLocalStableKey({ namespace, value }: { namespace: string; value: string }): string {
	return [STABLE_KEY_VERSION, "local", encodeComponent(namespace), encodeComponent(value)].join(":");
}

/**
 * Stable key of a row that hangs under a parent: the parent's stored stable key, or its id under the
 * parent namespace when none is stored, followed by `suffix`.
 */
export function createChildStableKey({
	namespace,
	parentNamespace,
	parentId,
	parentStableKey,
	suffix = "",
}: {
	namespace: string;
	parentNamespace: string;
	parentId: string;
	parentStableKey?: string | null | undefined;
	suffix?: string;
}): string {
	const parentKey = parentStableKey ?? createLocalStableKey({ namespace: parentNamespace, value: parentId });

	return createLocalStableKey({ namespace, value: `${parentKey}${suffix}` });
}

export function createLocalMetadataStableKey({ title, type, releaseDate }: { title: string; type: string; releaseDate: string }): string {
	return createLocalStableKey({
		namespace: "metadata",
		value: `${normalizeComponent(title)}|${normalizeComponent(type)}|${normalizeComponent(releaseDate)}`,
	});
}
