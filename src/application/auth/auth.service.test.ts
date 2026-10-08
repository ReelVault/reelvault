import { afterEach, describe, expect, test } from "bun:test";
import { usersRepository } from "@/database/repositories/users.repository";
import { betterAuthApi } from "@/integrations/better-auth/better-auth.api";
import { serverConfig } from "@/server.config";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { authService } from "./auth.service";

const originalEnforceDescriptor = Object.getOwnPropertyDescriptor(serverConfig.auth, "enforceTwoFactor");

function setEnforceTwoFactor(value: boolean): void {
	Object.defineProperty(serverConfig.auth, "enforceTwoFactor", { value, configurable: true });
}

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();

	if (originalEnforceDescriptor) Object.defineProperty(serverConfig.auth, "enforceTwoFactor", originalEnforceDescriptor);
});

function loginRequest(): Request {
	return new Request("http://localhost:3030/v1/auth/login", { method: "POST" });
}

describe("authService.login enforceTwoFactor", () => {
	test("rejects accounts without configured TOTP while enforcement is on", async () => {
		setEnforceTwoFactor(true);
		stubs.push(
			stubMethod(usersRepository, "findByEmail", () => ({ id: "u1", twoFactorEnabled: false })),
			stubMethod(betterAuthApi, "signInEmail", () => new Response("{}", { status: 200 })),
		);

		let failure: { code?: string } | undefined;
		try {
			await authService.login({ email: "no-totp@example.com", password: "pw" }, loginRequest());
		} catch (error) {
			failure = error as { code?: string };
		}

		expect(failure?.code).toBe("auth.two_factor_required");
	});

	test("lets accounts with TOTP through while enforcement is on", async () => {
		setEnforceTwoFactor(true);
		stubs.push(
			stubMethod(usersRepository, "findByEmail", () => ({ id: "u1", twoFactorEnabled: true })),
			stubMethod(betterAuthApi, "signInEmail", () => new Response("{}", { status: 200 })),
		);

		const response = await authService.login({ email: "totp@example.com", password: "pw" }, loginRequest());

		expect(response.status).toBe(200);
	});

	test("does not consult two-factor state while enforcement is off", async () => {
		setEnforceTwoFactor(false);
		stubs.push(stubMethod(betterAuthApi, "signInEmail", () => new Response("{}", { status: 200 })));
		const findByEmail = stubMethod(usersRepository, "findByEmail", () => ({ id: "u1", twoFactorEnabled: false }));
		stubs.push(findByEmail);

		await authService.login({ email: "legacy@example.com", password: "pw" }, loginRequest());

		expect(findByEmail.calls).toHaveLength(0);
	});
});

describe("authService.changePassword", () => {
	const body = { currentPassword: "old-password", newPassword: "new-password-1" };
	const request = new Request("http://localhost:3030/v1/auth/change-password", { method: "POST" });

	async function failureCode(response: Response): Promise<string | undefined> {
		stubs.push(stubMethod(betterAuthApi, "changePassword", () => response));
		try {
			await authService.changePassword(body, request);
		} catch (error) {
			return (error as { code?: string }).code;
		}

		return undefined;
	}

	test("passes the better-auth response through on success", async () => {
		stubs.push(stubMethod(betterAuthApi, "changePassword", () => Response.json({ token: "t", user: {} })));

		const response = await authService.changePassword(body, request);

		expect(response.status).toBe(200);
	});

	test("maps a wrong current password to a 400-class code, never a 401", async () => {
		const code = await failureCode(Response.json({ code: "INVALID_PASSWORD" }, { status: 400 }));

		expect(code).toBe("auth.invalid_current_password");
	});

	test("maps length violations to auth.weak_password", async () => {
		expect(await failureCode(Response.json({ code: "PASSWORD_TOO_SHORT" }, { status: 400 }))).toBe("auth.weak_password");
		expect(await failureCode(Response.json({ code: "PASSWORD_TOO_LONG" }, { status: 400 }))).toBe("auth.weak_password");
	});

	test("a provider failure surfaces as an internal error", async () => {
		expect(await failureCode(new Response("nope", { status: 500 }))).toBe("internal");
	});
});
