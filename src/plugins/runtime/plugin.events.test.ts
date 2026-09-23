import { describe, expect, it } from "bun:test";
import { PluginEventBus } from "./plugin.events";

describe("plugin event bus", () => {
	it("isolates handler failures and removes all handlers owned by a plugin", async () => {
		const bus = new PluginEventBus();
		const received: Array<{ mediaFileId: string; payloadVersion: number; correlationId: string; eventId: string; occurredAt: string }> = [];

		bus.on("first", "media.file.ready", (payload) => {
			received.push(payload);
		});
		bus.on("broken", "media.file.ready", () => {
			throw new Error("handler failure");
		});

		await expect(
			bus.emit("media.file.ready", {
				libraryId: "library",
				mediaFileId: "file",
				metadataId: "metadata",
				correlationId: "scan-1",
			}),
		).resolves.toBeUndefined();
		expect(received).toEqual([
			expect.objectContaining({
				mediaFileId: "file",
				payloadVersion: 1,
				correlationId: "scan-1",
				eventId: expect.any(String),
				occurredAt: expect.any(String),
			}),
		]);
		expect(Object.isFrozen(received[0])).toBeTrue();

		bus.offPlugin("first");
		await bus.emit("media.file.ready", { libraryId: "library", mediaFileId: "next", metadataId: "metadata" });
		expect(received).toHaveLength(1);
	});
});
