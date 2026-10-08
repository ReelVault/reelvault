import { afterEach, describe, expect, test } from "bun:test";
import { credentialsRepository } from "@/database/repositories/credentials.repository";
import { sessionsRepository } from "@/database/repositories/sessions.repository";
import { usersRepository } from "@/database/repositories/users.repository";
import { betterAuthApi } from "@/integrations/better-auth/better-auth.api";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { passwordRecoveryService } from "./password-recovery.service";

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

function stubRecovery(options: { user?: { id: string; email: string } | undefined; hasPasswordLogin?: boolean } = {}) {
	const calls = {
		hash: stubMethod(betterAuthApi, "hashPassword", (password: string) => Promise.resolve(`hashed:${password}`)),
		setHash: stubMethod(credentialsRepository, "setPasswordHash", () => Promise.resolve(options.hasPasswordLogin ?? true)),
		clear2fa: stubMethod(credentialsRepository, "clearTwoFactor", () => Promise.resolve()),
		sessions: stubMethod(sessionsRepository, "deleteAllForUser", () => Promise.resolve()),
	};
	stubs.push(
		stubMethod(usersRepository, "findByEmail", () => Promise.resolve(options.user)),
		...Object.values(calls),
	);

	return calls;
}

const alice = { id: "u1", email: "alice@example.com" };

describe("passwordRecoveryService.resetPassword", () => {
	test("stores a hash, revokes every session and leaves two-factor alone by default", async () => {
		const calls = stubRecovery({ user: alice });

		const result = await passwordRecoveryService.resetPassword({ email: " alice@example.com ", newPassword: "a-new-password" });

		expect(result).toEqual({ userId: "u1", email: "alice@example.com" });
		expect(calls.setHash.calls).toEqual([["u1", "hashed:a-new-password"]]);
		expect(calls.sessions.calls).toEqual([["u1"]]);
		expect(calls.clear2fa.calls).toHaveLength(0);
	});

	test("clears two-factor when asked (lost authenticator)", async () => {
		const calls = stubRecovery({ user: alice });

		await passwordRecoveryService.resetPassword({ email: alice.email, newPassword: "a-new-password", disableTwoFactor: true });

		expect(calls.clear2fa.calls).toEqual([["u1"]]);
	});

	test("rejects a password outside 8-128 characters before touching anything", async () => {
		const calls = stubRecovery({ user: alice });

		await expect(passwordRecoveryService.resetPassword({ email: alice.email, newPassword: "short" })).rejects.toMatchObject({
			code: "auth.weak_password",
		});
		expect(calls.setHash.calls).toHaveLength(0);
	});

	test("reports an unknown email and an account without password login", async () => {
		stubRecovery({ user: undefined });
		await expect(passwordRecoveryService.resetPassword({ email: "x@example.com", newPassword: "a-new-password" })).rejects.toMatchObject({
			category: "not_found",
		});

		for (const stub of stubs.splice(0)) stub.restore();
		stubRecovery({ user: alice, hasPasswordLogin: false });
		await expect(passwordRecoveryService.resetPassword({ email: alice.email, newPassword: "a-new-password" })).rejects.toMatchObject({
			code: "auth.no_password_login",
		});
	});
});
