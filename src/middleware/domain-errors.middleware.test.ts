import { expect, test } from "bun:test";
import Elysia, { t } from "elysia";
import { ConflictError, NotFoundError, TooManyRequestsError, ValidationError } from "@/utils/errors";
import { domainErrorsMiddleware } from "./domain-errors.middleware";

test("domain error middleware maps categories to HTTP responses without user-facing text", async () => {
	const app = new Elysia()
		.use(domainErrorsMiddleware)
		.get("/validation", () => {
			throw new ValidationError("Invalid input");
		})
		.get("/conflict", () => {
			throw new ConflictError("Already exists");
		});

	const [validation, conflict] = await Promise.all([
		app.handle(new Request("http://localhost/validation")),
		app.handle(new Request("http://localhost/conflict")),
	]);

	expect(validation.status).toBe(400);
	expect(await validation.json()).toEqual({ statusCode: 400, code: "validation" });
	expect(conflict.status).toBe(409);
	expect(await conflict.json()).toEqual({ statusCode: 409, code: "conflict" });
});

test("domain error middleware carries a granular code and params", async () => {
	const app = new Elysia().use(domainErrorsMiddleware).get("/missing", () => {
		throw new NotFoundError("Profile missing", { code: "profile.not_found", params: { profileId: "p1", retryable: false } });
	});

	const res = await app.handle(new Request("http://localhost/missing"));
	expect(res.status).toBe(404);
	expect(await res.json()).toEqual({
		statusCode: 404,
		code: "profile.not_found",
		params: { profileId: "p1", retryable: false },
	});
});

test("domain error middleware includes details when provided", async () => {
	const app = new Elysia().use(domainErrorsMiddleware).get("/with-details", () => {
		throw new ValidationError("Invalid input", { details: { field: "email" } });
	});

	const res = await app.handle(new Request("http://localhost/with-details"));
	expect(res.status).toBe(400);
	expect(await res.json()).toEqual({
		statusCode: 400,
		code: "validation",
		details: { field: "email" },
	});
});

test("elysia request validation is mapped to the same envelope", async () => {
	const app = new Elysia().use(domainErrorsMiddleware).post("/echo", ({ body }) => body, {
		body: t.Object({ name: t.String() }),
	});

	const res = await app.handle(
		new Request("http://localhost/echo", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: 123 }),
		}),
	);

	expect(res.status).toBe(400);
	const payload = (await res.json()) as { statusCode: number; code: string; details?: unknown };
	expect(payload.statusCode).toBe(400);
	expect(payload.code).toBe("validation.invalid_request");
});

test("a response that violates its own schema is a server error, not a client validation error", async () => {
	const app = new Elysia().use(domainErrorsMiddleware).get("/broken", () => ({ count: 1 }), {
		response: t.Object({ count: t.Number({ minimum: 10 }) }),
	});

	const res = await app.handle(new Request("http://localhost/broken"));

	expect(res.status).toBe(500);
	expect(await res.json()).toEqual({ statusCode: 500, code: "internal" });
});

test("invalid query input stays a 400 even when the route also declares a response schema", async () => {
	const app = new Elysia().use(domainErrorsMiddleware).get("/typed", ({ query }) => ({ page: query.page }), {
		query: t.Object({ page: t.Numeric() }),
		response: t.Object({ page: t.Number() }),
	});

	const res = await app.handle(new Request("http://localhost/typed?page=abc"));

	expect(res.status).toBe(400);
	expect(((await res.json()) as { code: string }).code).toBe("validation.invalid_request");
});

test("a 429 with retryAfterSeconds also sends the Retry-After header", async () => {
	const app = new Elysia().use(domainErrorsMiddleware).get("/slow-down", () => {
		throw new TooManyRequestsError("Too many", { code: "rate_limit.exceeded", params: { retryAfterSeconds: 12.2 } });
	});

	const res = await app.handle(new Request("http://localhost/slow-down"));

	expect(res.status).toBe(429);
	expect(res.headers.get("retry-after")).toBe("13");
	expect(((await res.json()) as { params: { retryAfterSeconds: number } }).params.retryAfterSeconds).toBe(12.2);
});

test("a 429 without a retry hint sends no Retry-After header", async () => {
	const app = new Elysia().use(domainErrorsMiddleware).get("/busy", () => {
		throw new TooManyRequestsError("Too many");
	});

	const res = await app.handle(new Request("http://localhost/busy"));

	expect(res.status).toBe(429);
	expect(res.headers.get("retry-after")).toBeNull();
});
