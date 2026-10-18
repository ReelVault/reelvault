import { afterEach, describe, expect, test } from "bun:test";
import { usersRepository } from "@/app/repositories/users.repository";
import { serverConfig } from "@/config/server/server.config";
import { systemSettingsStore } from "@/config/system-settings.store";
import { betterAuthApi } from "@/integrations/better-auth/better-auth.api";
import { stubMethod } from "../../../tests/helpers/method-stub.helper";
import { authService } from "./auth.service";

const originalEnforceDescriptor = Object.getOwnPropertyDescriptor(serverConfig.auth, "enforceTwoFactor");

function setEnforceTwoFactor(value: boolean): void {
	Object.defineProperty(serverConfig.auth, "enforceTwoFactor", { value, configurable: true });
}

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
	// The throttle test writes a runtime login limit; a failing assertion must not leave it behind for other files.
	systemSettingsStore.clearRuntimeValues();

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

	test("maps a wrong current password to a 400-class code, never a 401", async () => {
		const code = await failureCode(Response.json({ code: "INVALID_PASSWORD" }, { status: 400 }));

		expect(code).toBe("auth.invalid_current_password");
	});
});

describe("authService.login attempt throttle", () => {
	test("a successful sign-in clears the failed attempts counted against the account", async () => {
		const limit = serverConfig.auth.loginAccountMaxAttempts;
		systemSettingsStore.setRuntimeValue("auth.rateLimit.loginAccountMaxAttempts", 3);
		setEnforceTwoFactor(false);
		let outcome: "wrong" | "right" = "wrong";
		stubs.push(
			stubMethod(betterAuthApi, "signInEmail", () =>
				outcome === "wrong" ? Response.json({ code: "INVALID_EMAIL_OR_PASSWORD" }, { status: 401 }) : new Response("{}", { status: 200 }),
			),
		);
		const attempt = async () => {
			try {
				return (await authService.login({ email: "typos@example.com", password: "pw" }, loginRequest())).status;
			} catch (error) {
				return (error as { code?: string }).code;
			}
		};

		expect(await attempt()).toBe("auth.invalid_credentials");
		expect(await attempt()).toBe("auth.invalid_credentials");
		outcome = "right";
		expect(await attempt()).toBe(200);
		outcome = "wrong";
		// Without the reset the account would already be at its 3-attempt ceiling here.
		expect(await attempt()).toBe("auth.invalid_credentials");
		expect(await attempt()).toBe("auth.invalid_credentials");

		systemSettingsStore.clearRuntimeValues();
		expect(serverConfig.auth.loginAccountMaxAttempts).toBe(limit);
	});
});
