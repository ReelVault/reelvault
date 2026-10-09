import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { domainErrorsMiddleware } from "@/middleware/domain-errors.middleware";
import { serverConfig } from "@/server.config";
import { capabilitiesRoutes } from "./capabilities.routes";

const app = new Elysia().use(domainErrorsMiddleware).use(capabilitiesRoutes);

test("capabilities are public and mirror the trickplay and downloads settings", async () => {
	const res = await app.handle(new Request("http://localhost/capabilities"));

	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({ trickplay: serverConfig.trickplay.enabled, downloads: serverConfig.downloads.enabled });
});
