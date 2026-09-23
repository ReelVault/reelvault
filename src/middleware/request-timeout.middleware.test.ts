import { expect, test } from "bun:test";
import Elysia from "elysia";
import { domainErrorsMiddleware } from "./domain-errors.middleware";
import { requestTimeoutMiddleware } from "./request-timeout.middleware";

test("request timeout middleware rejects slow handlers", async () => {
	const app = new Elysia()
		.use(domainErrorsMiddleware)
		.use(requestTimeoutMiddleware)
		.get(
			"/slow",
			async () => {
				await new Promise((resolve) => {
					setTimeout(resolve, 200);
				});

				return "done";
			},
			{ timeout: { ms: 50 } },
		);

	const res = await app.handle(new Request("http://localhost/slow"));
	expect(res.status).toBe(408);

	const body = await res.json();
	expect(body.code).toBe("request.timeout");
	expect(body).not.toHaveProperty("message");
});

test("request timeout middleware passes fast handlers", async () => {
	const app = new Elysia()
		.use(domainErrorsMiddleware)
		.use(requestTimeoutMiddleware)
		.get("/fast", () => "done", { timeout: { ms: 5000 } });

	const res = await app.handle(new Request("http://localhost/fast"));
	expect(res.status).toBe(200);
	expect(await res.text()).toBe("done");
});

test("request timeout middleware includes requestId in error response", async () => {
	const app = new Elysia()
		.use(domainErrorsMiddleware)
		.use(requestTimeoutMiddleware)
		.get(
			"/slow",
			async () => {
				await new Promise((resolve) => {
					setTimeout(resolve, 200);
				});

				return "done";
			},
			{ timeout: { ms: 50 } },
		);

	const res = await app.handle(
		new Request("http://localhost/slow", {
			headers: { "x-request-id": "test-req-123" },
		}),
	);
	expect(res.status).toBe(408);
	const body = (await res.json()) as { code?: string; details?: { requestId?: string } };
	expect(body.code).toBe("request.timeout");
	expect(body.details?.requestId).toBe("test-req-123");
});
