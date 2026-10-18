import { afterEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { domainErrorsMiddleware } from "@/app/http/middleware/domain-errors.middleware";
import { systemSettingsStore } from "@/config/system-settings.store";
import { capabilitiesRoutes } from "./capabilities.routes";

const app = new Elysia().use(domainErrorsMiddleware).use(capabilitiesRoutes);

afterEach(() => {
	systemSettingsStore.clearRuntimeValues();
});

test("capabilities are public and report the live trickplay and downloads settings", async () => {
	const defaults = await app.handle(new Request("http://localhost/capabilities"));

	expect(defaults.status).toBe(200);
	expect(await defaults.json()).toEqual({ trickplay: true, downloads: true });

	systemSettingsStore.setParsedRuntimeValue("trickplay.enabled", false);
	systemSettingsStore.setParsedRuntimeValue("downloads.enabled", false);

	const updated = await app.handle(new Request("http://localhost/capabilities"));

	expect(await updated.json()).toEqual({ trickplay: false, downloads: false });
});
