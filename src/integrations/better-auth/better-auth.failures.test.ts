import { describe, expect, test } from "bun:test";
import { APIError } from "better-auth/api";
import { toAuthFailure, withAuthFailures } from "./better-auth.failures";

const failure = (code: string, status = 400) => new Response(JSON.stringify({ code, message: "English prose" }), { status });

describe("toAuthFailure", () => {
	test.each([
		["USER_ALREADY_EXISTS", 422, "auth.email_registered", "conflict"],
		["USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL", 422, "auth.email_registered", "conflict"],
		["PASSWORD_TOO_SHORT", 400, "auth.weak_password", "validation"],
		["PASSWORD_TOO_LONG", 400, "auth.weak_password", "validation"],
		["INVALID_EMAIL", 400, "auth.invalid_email", "validation"],
		["BANNED_USER", 403, "auth.user_banned", "forbidden"],
		["INVALID_EMAIL_OR_PASSWORD", 401, "auth.invalid_credentials", "unauthorized"],
	])("%s becomes %s", async (betterAuthCode, status, code, category) => {
		const error = await toAuthFailure(failure(betterAuthCode, status));

		expect(error.code).toBe(code);
		expect(String(error.category)).toBe(category);
	});

	test("a wrong current password is a validation error, never a 401", async () => {
		const error = await toAuthFailure(failure("INVALID_PASSWORD"), "auth.invalid_current_password");

		expect(error.code).toBe("auth.invalid_current_password");
		expect(error.category).toBe("validation");
	});

	test("an unrecognised 401 still reads as invalid credentials", async () => {
		expect((await toAuthFailure(new Response("", { status: 401 }))).code).toBe("auth.invalid_credentials");
	});

	test("unknown 4xx are rejected requests, 5xx are internal errors", async () => {
		expect((await toAuthFailure(failure("SOMETHING_NEW", 429))).code).toBe("auth.request_rejected");
		expect((await toAuthFailure(new Response("boom", { status: 502 }))).category).toBe("internal");
	});

	test("the English message never reaches the error", async () => {
		const error = await toAuthFailure(failure("USER_ALREADY_EXISTS", 422));

		expect(error.message).not.toContain("English prose");
	});
});

describe("status fallbacks", () => {
	test("403 and 404 keep their plain categories", async () => {
		expect((await toAuthFailure(failure("YOU_ARE_NOT_ALLOWED", 403))).code).toBe("forbidden");
		expect((await toAuthFailure(failure("USER_NOT_FOUND", 404))).code).toBe("not_found");
	});
});

describe("withAuthFailures", () => {
	test("rethrows a better-auth APIError as a DomainError with a stable code", async () => {
		const failing = () => Promise.reject(new APIError("BAD_REQUEST", { code: "USER_ALREADY_EXISTS", message: "User already exists" }));

		await expect(withAuthFailures(failing)).rejects.toMatchObject({ code: "auth.email_registered", category: "conflict" });
	});

	test("maps the APIError status when it carries no known code", async () => {
		const failing = () => Promise.reject(new APIError("FORBIDDEN", { message: "nope" }));

		await expect(withAuthFailures(failing)).rejects.toMatchObject({ category: "forbidden" });
	});

	test("lets unrelated errors and results pass through untouched", async () => {
		await expect(withAuthFailures(() => Promise.resolve(42))).resolves.toBe(42);
		await expect(withAuthFailures(() => Promise.reject(new TypeError("bug")))).rejects.toBeInstanceOf(TypeError);
	});
});
