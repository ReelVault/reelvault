import { expect, test } from "bun:test";
import Elysia, { t } from "elysia";
import { ConflictError, NotFoundError, ValidationError } from "@/utils/errors";
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
