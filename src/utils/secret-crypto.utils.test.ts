import { describe, expect, test } from "bun:test";
import { decryptSecret, deriveSecretKey, encryptSecret } from "./secret-crypto.utils";

describe("secret crypto utils", () => {
	test("round-trips a secret", () => {
		const master = "master-secret-used-for-derivation";
		const encrypted = encryptSecret("ghp_example_token_1234567890", master);
		expect(encrypted).not.toContain("ghp_example_token_1234567890");
		expect(decryptSecret(encrypted, master)).toBe("ghp_example_token_1234567890");
	});

	test("produces different ciphertexts for the same plaintext", () => {
		const master = "master-secret-used-for-derivation";
		const first = encryptSecret("same-value", master);
		const second = encryptSecret("same-value", master);

		// The random IV makes every ciphertext unique, so two encryptions of the
		// same plaintext are two distinct payloads.
		expect(first).not.toBe(second);
		expect(decryptSecret(first, master)).toBe("same-value");
		expect(decryptSecret(second, master)).toBe("same-value");
	});

	test("produces different ciphertexts for different plaintexts", () => {
		const master = "master-secret-used-for-derivation";
		const first = encryptSecret("value-a", master);
		const second = encryptSecret("value-b", master);

		expect(first).not.toBe(second);
	});

	test("fails to decrypt with a different master secret", () => {
		const encrypted = encryptSecret("value", "master-a");

		// The cipher authenticates the payload, so the wrong key fails instead of
		// returning garbage. The cipher reports a plain Error, not a domain error.
		expect(() => decryptSecret(encrypted, "master-b")).toThrow(expect.objectContaining({ name: "Error" }));
		// The payload itself is intact — only the key was wrong.
		expect(decryptSecret(encrypted, "master-a")).toBe("value");
	});

	test("rejects tampered ciphertexts", () => {
		const master = "master-secret-used-for-derivation";
		const encrypted = encryptSecret("value", master);
		const parts = encrypted.split(".");
		const ciphertext = Buffer.from(parts[2] ?? "", "base64url");
		ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;
		const tampered = [parts[0], parts[1], ciphertext.toString("base64url"), parts[3]].join(".");

		expect(() => decryptSecret(tampered, master)).toThrow(expect.objectContaining({ name: "Error" }));
		// The untouched payload still decrypts, so only the modified bytes were rejected.
		expect(decryptSecret(encrypted, master)).toBe("value");
	});

	test("rejects unsupported payload versions", () => {
		expect(() => decryptSecret("v99.abc.def.ghi", "master-secret-used-for-derivation")).toThrow(
			expect.objectContaining({ category: "internal", code: "secret.unsupported_payload" }),
		);
	});

	test("derives stable keys from the same master secret", () => {
		expect(deriveSecretKey("master").equals(deriveSecretKey("master"))).toBe(true);
		expect(deriveSecretKey("master").equals(deriveSecretKey("other"))).toBe(false);
	});
});
