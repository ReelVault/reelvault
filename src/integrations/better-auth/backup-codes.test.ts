import { describe, expect, test } from "bun:test";
import { symmetricEncrypt } from "better-auth/crypto";
import { env } from "@/config/env.config";
import { countEncryptedBackupCodes } from "./backup-codes.reader";

describe("countEncryptedBackupCodes", () => {
	test("counts the codes in a list encrypted under the auth secret", async () => {
		const encrypted = await symmetricEncrypt({ key: env.BETTER_AUTH_SECRET, data: JSON.stringify(["aaaaa-bbbbb", "ccccc-ddddd"]) });

		await expect(countEncryptedBackupCodes(encrypted)).resolves.toBe(2);
	});

	test("returns null for a record it cannot read", async () => {
		await expect(countEncryptedBackupCodes("not-an-encrypted-record")).resolves.toBeNull();
	});
});
