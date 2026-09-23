import { describe, expect, test } from "bun:test";
import { profilePinFingerprint, signProfileUnlock, verifyProfileUnlock } from "./profile-unlock.utils";

const SECRET = "test-secret-key";

describe("profile unlock token", () => {
	test("round-trips a valid token including its PIN fingerprint", () => {
		const fingerprint = profilePinFingerprint("$argon2id$stored-hash");
		const token = signProfileUnlock("profile-1", SECRET, fingerprint, 60);
		const verified = verifyProfileUnlock(token, SECRET);
		expect(verified?.profileId).toBe("profile-1");
		expect(verified?.pinFingerprint).toBe(fingerprint);
	});

	test("rejects a tampered token or wrong secret", () => {
		const token = signProfileUnlock("profile-1", SECRET, "", 60);
		expect(verifyProfileUnlock(`${token}x`, SECRET)).toBeNull();
		expect(verifyProfileUnlock(token, "other-secret")).toBeNull();
	});

	test("rejects an expired token", () => {
		const token = signProfileUnlock("profile-1", SECRET, "", -1);
		expect(verifyProfileUnlock(token, SECRET)).toBeNull();
	});

	test("rejects malformed input", () => {
		expect(verifyProfileUnlock(undefined, SECRET)).toBeNull();
		expect(verifyProfileUnlock("not-a-token", SECRET)).toBeNull();
	});

	test("fingerprint tracks the PIN hash and is empty without a PIN", () => {
		expect(profilePinFingerprint(null)).toBe("");
		expect(profilePinFingerprint("hash-a")).not.toBe(profilePinFingerprint("hash-b"));
	});
});
