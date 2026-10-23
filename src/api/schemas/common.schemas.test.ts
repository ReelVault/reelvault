import { describe, expect, it } from "bun:test";
import { Elysia, t } from "elysia";
import { domainErrorsMiddleware } from "@/api/middleware/domain-errors.middleware";
import { ClampedNumeric, PaginationSchema } from "./common.schema";

describe("ClampedNumeric", () => {
	it("clamps query values above and below the configured bounds", async () => {
		const app = new Elysia().get("/", ({ query }) => query, {
			query: t.Object({ limit: t.Optional(ClampedNumeric(1, 100)) }),
		});

		const upperResponse = await app.handle(new Request("http://localhost/?limit=200"));
		const lowerResponse = await app.handle(new Request("http://localhost/?limit=0"));

		expect(upperResponse.status).toBe(200);
		expect(await upperResponse.json()).toEqual({ limit: 100 });
		expect(lowerResponse.status).toBe(200);
		expect(await lowerResponse.json()).toEqual({ limit: 1 });
	});

	it("refuses a fractional query value as a validation error", async () => {
		const app = new Elysia().use(domainErrorsMiddleware).get("/", ({ query }) => query, {
			query: t.Object({ limit: t.Optional(ClampedNumeric(1, 100)) }),
		});

		const response = await app.handle(new Request("http://localhost/?limit=1.5"));

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ statusCode: 400, code: "validation.invalid_request" });
	});
});

describe("PaginationSchema", () => {
	it("refuses a fractional page or limit as a validation error", async () => {
		const app = new Elysia().use(domainErrorsMiddleware).get("/", ({ query }) => query, { query: PaginationSchema });

		for (const query of ["page=1.5", "limit=1.5"]) {
			const response = await app.handle(new Request(`http://localhost/?${query}`));

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ statusCode: 400, code: "validation.invalid_request" });
		}
	});
});
