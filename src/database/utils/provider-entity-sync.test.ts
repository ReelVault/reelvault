import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { providersRepository } from "@/database/repositories/providers.repository";
import { syncNamedProviderEntities } from "./provider-entity-sync";

type ProviderRow = Awaited<ReturnType<typeof providersRepository.selectMany>>[number];

function createMockProvider(overrides: Partial<ProviderRow> = {}): ProviderRow {
	return {
		id: "p-1",
		stableKey: "v1:tmdb:genre:g-1",
		name: "tmdb",
		entityType: "genre",
		externalId: "g-1",
		createdAt: new Date("2026-08-01T00:00:00.000Z"),
		updatedAt: new Date("2026-08-01T00:00:00.000Z"),
		...overrides,
	};
}

const upsert = spyOn(providersRepository, "upsertByStableKey").mockResolvedValue([]);
const selectMany = spyOn(providersRepository, "selectMany").mockResolvedValue([]);

beforeEach(() => {
	upsert.mockClear();
	selectMany.mockClear();
	selectMany.mockResolvedValue([]);
});

describe("syncNamedProviderEntities", () => {
	test("does nothing for an empty item list", async () => {
		await syncNamedProviderEntities({
			items: [],
			providerName: "tmdb",
			entityType: "genre",
			insertEntities: async () => {
				/* intentionally empty */
			},
			selectEntities: async () => [],
			persistAssociations: async () => {
				/* intentionally empty */
			},
		});

		expect(upsert).not.toHaveBeenCalled();
	});

	test("inserts one stable entity per unique trimmed name and skips blank names", async () => {
		const inserted: Array<{ name: string; stableKey: string }> = [];
		const persist: Array<{ entityId: string; input: { id: string; name: string } }> = [];

		await syncNamedProviderEntities({
			items: [
				{ id: "g-1", name: "  Action " },
				{ id: "g-2", name: "Action" },
				{ id: "g-3", name: "   " },
			],
			providerName: "tmdb",
			entityType: "genre",
			insertEntities: (items) => {
				inserted.push(...items);

				return Promise.resolve();
			},
			selectEntities: async () => [{ id: "e-1", stableKey: "k", name: "Action" }],
			persistAssociations: (associations) => {
				persist.push(...associations);

				return Promise.resolve();
			},
		});

		// Two different external ids map to the same trimmed name, blank name dropped.
		expect(inserted).toHaveLength(1);
		expect(inserted[0]?.name).toBe("Action");
		// Stable key is namespaced by entity type (hex-encoded: 67656e7265 = "genre")
		// and value (616374696f6e = "action").
		expect(inserted[0]?.stableKey).toBe("v1:local:67656e7265:616374696f6e");
		expect(persist).toHaveLength(1);
		expect(persist[0]?.entityId).toBe("e-1");
	});

	test("deduplicates associations by (entityId, providerId) pairs", async () => {
		const persist: Array<{ entityId: string; providerId?: string | undefined }> = [];
		// Two provider rows resolve for external ids g-1 and g-2.
		selectMany.mockResolvedValue([
			createMockProvider({ id: "p-1", name: "tmdb", entityType: "genre", externalId: "g-1" }),
			createMockProvider({ id: "p-2", name: "tmdb", entityType: "genre", externalId: "g-2" }),
		]);

		await syncNamedProviderEntities({
			items: [
				{ id: "g-1", name: "Action" },
				{ id: "g-2", name: "Action" },
			],
			providerName: "tmdb",
			entityType: "genre",
			insertEntities: async () => {
				/* intentionally empty */
			},
			selectEntities: async () => [{ id: "e-1", stableKey: "k", name: "Action" }],
			persistAssociations: (associations) => {
				persist.push(...associations);

				return Promise.resolve();
			},
		});

		expect(persist).toHaveLength(2);
		expect(persist.map((a) => a.providerId)).toEqual(["p-1", "p-2"]);
	});

	test("drops associations whose entity name did not resolve locally", async () => {
		const persist: unknown[] = [];

		await syncNamedProviderEntities({
			items: [{ id: "g-1", name: "Unknown Genre" }],
			providerName: "tmdb",
			entityType: "genre",
			insertEntities: async () => {
				/* intentionally empty */
			},
			selectEntities: async () => [],
			persistAssociations: (associations) => {
				persist.push(...associations);

				return Promise.resolve();
			},
		});

		expect(persist).toHaveLength(0);
	});

	test("associations without a provider row keep providerId undefined", async () => {
		const persist: Array<{ providerId?: string | undefined }> = [];

		await syncNamedProviderEntities({
			items: [{ id: "g-1", name: "Action" }],
			providerName: "tmdb",
			entityType: "genre",
			insertEntities: async () => {
				/* intentionally empty */
			},
			selectEntities: async () => [{ id: "e-1", stableKey: "k", name: "Action" }],
			persistAssociations: (associations) => {
				persist.push(...associations);

				return Promise.resolve();
			},
		});

		expect(persist).toHaveLength(1);
		expect(persist[0]?.providerId).toBeUndefined();
	});
});
