import { symmetricDecrypt } from "better-auth/crypto";
import { env } from "@/config/env.config";

/**
 * How many backup codes are left in the list better-auth stores encrypted under the auth secret.
 * Returns `null` when the record cannot be read (wrong secret or a damaged value); the codes are never returned.
 */
export async function countEncryptedBackupCodes(encrypted: string): Promise<number | null> {
	try {
		const codes: unknown = JSON.parse(await symmetricDecrypt({ key: env.BETTER_AUTH_SECRET, data: encrypted }));

		return Array.isArray(codes) ? codes.length : null;
	} catch {
		return null;
	}
}
