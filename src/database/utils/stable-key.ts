import type { ProviderEntityType } from "@sdk/common/provider.types";
import { encodeComponent, normalizeComponent } from "@/utils/image-storage.utils";

const STABLE_KEY_VERSION = "v1";

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

export function createLocalMetadataStableKey({ title, type, releaseDate }: { title: string; type: string; releaseDate: string }): string {
	return createLocalStableKey({
		namespace: "metadata",
		value: `${normalizeComponent(title)}|${normalizeComponent(type)}|${normalizeComponent(releaseDate)}`,
	});
}
