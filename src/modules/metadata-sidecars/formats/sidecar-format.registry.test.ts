import { expect, test } from "bun:test";
import type { SidecarFormatAdapter } from "./sidecar-format.adapter";
import { InMemorySidecarFormatRegistry } from "./sidecar-format.registry";

function createAdapter(id: string, canRead: boolean): SidecarFormatAdapter {
	return {
		id,
		capabilities: ["read"],
		canRead: async () => canRead,
		read: async () => null,
	};
}

test("sidecar format registry returns the first compatible reader", async () => {
	const registry = new InMemorySidecarFormatRegistry();
	const preferredAdapter = createAdapter("reelvault", true);
	registry.register(preferredAdapter);
	registry.register(createAdapter("jellyfin", true));

	expect(await registry.findReader({ documentPath: "/library/movie.nfo" })).toBe(preferredAdapter);
});

test("sidecar format registry rejects duplicate adapter IDs", () => {
	const registry = new InMemorySidecarFormatRegistry();
	registry.register(createAdapter("jellyfin", true));

	expect(() => registry.register(createAdapter("jellyfin", true))).toThrow("already registered");
});
