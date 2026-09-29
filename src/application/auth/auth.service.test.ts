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
