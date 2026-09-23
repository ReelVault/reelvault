import { expect, test } from "bun:test";
import { ReelVaultClient } from "@sdk/client/core/app-client";
import { librariesRoutes } from "./libraries.routes";

test("library routes compile with the FFmpeg error check endpoint and sidecar assets", () => {
	expect(() => librariesRoutes.compile()).not.toThrow();
});

test("ReelVaultClient has libraries.getIgnoredAssets method defined", () => {
	const client = new ReelVaultClient({ baseUrl: "http://localhost:3030" });
	expect(typeof client.libraries.getIgnoredAssets).toBe("function");
});

test("ReelVaultClient has libraries.getScanFindings method defined", () => {
	const client = new ReelVaultClient({ baseUrl: "http://localhost:3030" });
	expect(typeof client.libraries.getScanFindings).toBe("function");
});
