import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Symmetric encryption for secrets persisted in the database (e.g. plugin
 * repository access tokens). The key is derived from `BETTER_AUTH_SECRET`,
 * which already gates every session — nothing weaker is available at this
 * layer, and the ciphertexts never leave the server except as redacted rows.
 */

const HKDF_SALT = "reelvault:secret-crypto:v1";
const HKDF_INFO = "reelvault:secret-encryption-key";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const ALGORITHM = "aes-256-gcm";
/** Versioned payload so the derivation scheme can rotate without data migration. */
const PAYLOAD_VERSION = "v1";
const PAYLOAD_SEPARATOR = ".";

export function deriveSecretKey(masterSecret: string): Buffer {
	return Buffer.from(hkdfSync("sha256", masterSecret, HKDF_SALT, HKDF_INFO, KEY_BYTES));
}

export function encryptSecret(plaintext: string, masterSecret: string): string {
	const key = deriveSecretKey(masterSecret);
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv(ALGORITHM, key, iv);
	const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	const authTag = cipher.getAuthTag();

	return [PAYLOAD_VERSION, iv.toString("base64url"), encrypted.toString("base64url"), authTag.toString("base64url")].join(
		PAYLOAD_SEPARATOR,
	);
}

export function decryptSecret(payload: string, masterSecret: string): string {
	const parts = payload.split(PAYLOAD_SEPARATOR);
	if (parts.length !== 4) throw new Error("Unsupported secret payload format");

	const [version, iv, encrypted, authTag] = parts;
	if (version !== PAYLOAD_VERSION || !iv || !encrypted || !authTag) {
		throw new Error(`Unsupported secret payload format: ${version ?? "empty"}`);
	}

	const key = deriveSecretKey(masterSecret);
	const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64url"));
	decipher.setAuthTag(Buffer.from(authTag, "base64url"));

	return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}
