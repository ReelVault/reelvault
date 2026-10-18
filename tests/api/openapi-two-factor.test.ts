import { describe, expect, test } from "bun:test";
import { openapi } from "@elysiajs/openapi";
import { Elysia } from "elysia";
import { apiRouter } from "@/app/http/routes/api.routes";

interface OperationSchema {
	required?: string[];
	properties?: Record<string, { anyOf?: unknown[] }>;
}

interface OpenApiDocument {
	paths?: Record<string, { get?: { responses?: Record<string, { content?: Record<string, { schema?: OperationSchema }> }> } }>;
}

/** External integrations build against the published document, so the two-factor responses must be in it. */
describe("OpenAPI document", () => {
	test("the backup-code status documents its remaining count, which may be null", async () => {
		const app = new Elysia().use(openapi({ path: "/openapi" })).use(apiRouter);
		const response = await app.handle(new Request("http://localhost/openapi/json"));
		const document = (await response.json()) as OpenApiDocument;

		const schema = document.paths?.["/v1/auth/two-factor/backup-codes"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema;

		expect(schema?.required).toEqual(["remaining"]);
		expect(schema?.properties?.remaining?.anyOf).toContainEqual({ type: "null" });
	});
});
