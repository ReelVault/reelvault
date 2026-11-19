import { describe, expect, test } from "bun:test";
import { verifyPassword } from "better-auth/crypto";
import {
	insertAccounts,
	insertSessions,
	insertTwoFactors,
	insertUsers,
	selectAccounts,
	selectSessions,
	selectTwoFactors,
	selectUsers,
} from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { passwordRecoveryService } from "./password-recovery.service";

// Rows live in the migrated test database. The password is hashed by the real better-auth hasher.
const db = useTestDatabase();

async function seedAlice(options: { passwordLogin: boolean; twoFactor: boolean }): Promise<void> {
	const client = db.client();
	await insertUsers(client, {
		id: "u1",
		name: "Alice",
		email: "alice@example.com",
		emailVerified: true,
		twoFactorEnabled: options.twoFactor,
	});
	if (options.passwordLogin) {
		await insertAccounts(client, {
			id: "acc-1",
			accountId: "u1",
			providerId: "credential",
			userId: "u1",
			password: "old-hash",
		});
	}
	if (options.twoFactor) {
		await insertTwoFactors(client, { id: "tf-1", userId: "u1", secret: "secret", backupCodes: "[]" });
	}
	await insertSessions(client, {
		id: "s-1",
		userId: "u1",
		token: "token-1",
		expiresAt: new Date(Date.now() + 60_000),
	});
}

async function storedPassword(): Promise<string | null | undefined> {
	const account = (await selectAccounts(db.client())).find((row) => row.userId === "u1");

	return account?.password;
}

async function sessionCount(): Promise<number> {
	return (await selectSessions(db.client())).filter((row) => row.userId === "u1").length;
}

describe("passwordRecoveryService.resetPassword", () => {
	test("stores a new hash, revokes every session and leaves two-factor alone by default", async () => {
		await seedAlice({ passwordLogin: true, twoFactor: true });

		const result = await passwordRecoveryService.resetPassword({ email: " alice@example.com ", newPassword: "a-new-password" });

		expect(result).toEqual({ userId: "u1", email: "alice@example.com" });
		const stored = await storedPassword();
		expect(stored).not.toBe("old-hash");
		expect(await verifyPassword({ hash: stored ?? "", password: "a-new-password" })).toBe(true);
		expect(await sessionCount()).toBe(0);
		expect(await selectTwoFactors(db.client())).toHaveLength(1);
	});

	test("turns two-factor off when asked, for an operator who lost the authenticator", async () => {
		await seedAlice({ passwordLogin: true, twoFactor: true });

		await passwordRecoveryService.resetPassword({ email: "alice@example.com", newPassword: "a-new-password", disableTwoFactor: true });

		expect(await selectTwoFactors(db.client())).toEqual([]);
		const [user] = await selectUsers(db.client());
		expect(user?.twoFactorEnabled).toBe(false);
	});

	test("refuses an account without a password login and changes nothing", async () => {
		await seedAlice({ passwordLogin: false, twoFactor: false });

		await expect(
			passwordRecoveryService.resetPassword({ email: "alice@example.com", newPassword: "a-new-password" }),
		).rejects.toMatchObject({
			code: "auth.no_password_login",
		});
		expect(await sessionCount()).toBe(1);
	});

	test("refuses a password outside the length bounds before touching the account", async () => {
		await seedAlice({ passwordLogin: true, twoFactor: false });

		await expect(passwordRecoveryService.resetPassword({ email: "alice@example.com", newPassword: "short" })).rejects.toMatchObject({
			code: "auth.weak_password",
		});
		expect(await storedPassword()).toBe("old-hash");
		expect(await sessionCount()).toBe(1);
	});
});
