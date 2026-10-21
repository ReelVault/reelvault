import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { domainErrorsMiddleware } from "@/api/middleware/domain-errors.middleware";
import { pluginsRoutes } from "./plugins.routes";

const app = new Elysia().use(domainErrorsMiddleware).use(pluginsRoutes);

test("plugin dispatch rejects an unauthenticated request before it reaches a plugin", async () => {
	const response = await app.handle(new Request("http://localhost/plugins/org.example.menu/items"));

	expect(response.status).toBe(401);
});
