import { describe, expect, test } from "bun:test";
import * as sdk from "@reelvault/sdk";

/**
 * `export *` silently DROPS ambiguous names when two modules in the barrel
 * export the same symbol — the exact failure mode that let contracts/ and
 * database/ drift apart with 26 duplicate names. This test pins the key
 * exports of the merged `common` surface so a future collision (or an
 * accidental removal) fails loudly here instead of at a consumer.
 */
describe("sdk barrel surface", () => {
	test("exposes renamed collision-free symbols", () => {
		expect(sdk.SubtitleEntitySchema).toBeDefined();
		expect(sdk.SubtitleSchema).toBeDefined();
		// The plugin-facing file interface is type-only and renamed — the old
		// `MediaFile` value/name must not reappear as a runtime export.
		expect(Object.hasOwn(sdk, "PluginMediaFile")).toBe(false);
	});

	test("exposes representative entity, wire and helper symbols", () => {
		for (const name of [
			"MediaFileWithRelationSchema",
			"MediaFileSchema",
			"MetadataWithRelationSchema",
			"LibraryWithRelationsSchema",
			"LibraryDetailSchema",
			"EpisodeWithRelationsSchema",
			"MovieWithRelationsSchema",
			"CollectionWithRelationsSchema",
			"PersonWithRelationsSchema",
			"UserSchema",
			"SessionSchema",
			"ProfileSchema",
		]) {
			expect(sdk, name).toHaveProperty(name);
		}

		for (const name of [
			"PaginatedResponseSchema",
			"ProjectedResponseSchema",
			"ApiErrorResponseSchema",
			"SortQuerySchema",
			"PlaybackArtifactSchema",
			"WorkerJobSchema",
			"RegisterRequestSchema",
			"LoginRequestSchema",
			"SessionResponseSchema",
			"HealthResponseSchema",
			"SubtitleProviderStatusSchema",
			"defineFields",
		]) {
			expect(sdk, name).toHaveProperty(name);
		}
	});

	test("re-exports the client class", () => {
		expect(sdk.ReelVaultClient).toBeDefined();
		expect(sdk.ReelVaultValidationError).toBeDefined();
	});

	test("plugin surface single-sources lifecycle naming", async () => {
		const plugin = await import("@reelvault/sdk/plugin");
		expect(plugin.definePlugin).toBeTypeOf("function");
		// The lifecycle unions are re-exported types (from common/plugins) — their
		// single-sourcing is asserted at type level by tsc; here we pin the runtime
		// surface only.
		expect(Object.keys(plugin).length).toBeGreaterThan(5);
	});
});
