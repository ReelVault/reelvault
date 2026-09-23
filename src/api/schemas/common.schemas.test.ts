import { describe, expect, it } from "bun:test";
import { Elysia, t } from "elysia";
import { ClampedNumeric } from "./common.schemas";

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

	it("still rejects non-numeric values", async () => {
		const app = new Elysia().get("/", ({ query }) => query, {
			query: t.Object({ limit: t.Optional(ClampedNumeric(1, 100)) }),
		});

		const response = await app.handle(new Request("http://localhost/?limit=invalid"));

		expect(response.status).toBe(422);
	});
});
