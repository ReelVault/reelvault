import { describe, expect, test } from "bun:test";
import { profilePinFingerprint, signProfileUnlock, verifyProfileUnlock } from "./profile-unlock.utils";

const SECRET = "test-secret-key";

describe("profile unlock token", () => {
	test("round-trips a valid token including its PIN fingerprint", () => {
		const token = signProfileUnlock("profile-1", SECRET, profilePinFingerprint("$argon2id$stored-hash"), 60);
		const verified = verifyProfileUnlock(token, SECRET);

		expect(verified?.profileId).toBe("profile-1");
		// sha256("$argon2id$stored-hash") in base64url, truncated to 16 characters.
		expect(verified?.pinFingerprint).toBe("FTCpVyNENg3xN0Gm");
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

	test("fingerprints the stored PIN hash and is empty without a PIN", () => {
		// The fingerprint is the base64url sha256 of the stored PIN hash, cut to 16 characters.
		expect(profilePinFingerprint("$argon2id$stored-hash")).toBe("FTCpVyNENg3xN0Gm");
		expect(profilePinFingerprint("hash-a")).toBe("QAB1BpwZe7ywEUxm");
		expect(profilePinFingerprint("hash-b")).toBe("WA423ob-X94kwNZ9");
		expect(profilePinFingerprint(null)).toBe("");
	});
});
