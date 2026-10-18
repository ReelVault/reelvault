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
	registry.register(createAdapter("reelvault", false));
	const compatibleAdapter = createAdapter("jellyfin", true);
	registry.register(compatibleAdapter);
	registry.register(createAdapter("kodi", true));

	expect(await registry.findReader({ documentPath: "/library/movie.nfo" })).toBe(compatibleAdapter);
});

test("sidecar format registry rejects duplicate adapter IDs", () => {
	const registry = new InMemorySidecarFormatRegistry();
	registry.register(createAdapter("jellyfin", true));

	expect(() => registry.register(createAdapter("jellyfin", true))).toThrow(
		expect.objectContaining({ category: "conflict", code: "sidecar.adapter_already_registered" }),
	);
});
