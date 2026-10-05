import { timingSafeEqual } from "node:crypto";
import { CryptoHasher, password } from "bun";

interface Hasher {
	update(data: string | Uint8Array): Hasher;
	digest(encoding: "hex" | "base64"): string;
}

const CHECKSUM_PREFIX_REGEX = /^sha256-/;

/**
 * Constant-time comparison of two strings. With `checksum` enabled a leading
 * `sha256-` is stripped from both sides and hex case is ignored, so a streamed
 * archive hash (`sha256-<hex>`) can be compared against a published plain-hex
 * digest without pre-normalizing at the call site.
 */
export function constantTimeEquals(actual: string, expected: string, options: { checksum?: boolean } = {}): boolean {
	const left = options.checksum ? actual.replace(CHECKSUM_PREFIX_REGEX, "").toLowerCase() : actual;
	const right = options.checksum ? expected.replace(CHECKSUM_PREFIX_REGEX, "").toLowerCase() : expected;
	const actualBytes = Buffer.from(left);
	const expectedBytes = Buffer.from(right);

	return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

/**
 * Creates a cryptographic hash via Bun's native `Bun.CryptoHasher` (BoringSSL),
 * which is meaningfully faster than `node:crypto` under Bun. No Node fallback —
 * this codebase targets Bun exclusively.
 */
export function createHash(algorithm: ConstructorParameters<typeof Bun.CryptoHasher>[0]): Hasher {
	const hasher = new CryptoHasher(algorithm);
	const wrapper: Hasher = {
		update(data) {
			hasher.update(data);

			return wrapper;
		},
		digest(encoding) {
			return hasher.digest(encoding);
		},
	};

	return wrapper;
}

/**
 * Cryptographically secure integer in `[min, max]` (inclusive). Uses rejection
 * sampling to avoid modulo bias — never use `Math.random()` for codes/secrets.
 */
export function secureRandomInt(min: number, max: number): number {
	if (!(Number.isInteger(min) && Number.isInteger(max)) || max < min) {
		throw new RangeError(`Invalid random range: [${min}, ${max}]`);
	}

	const range = max - min + 1;
	const uint32Space = 0x1_0000_0000;
	const limit = uint32Space - (uint32Space % range);
	const buffer = new Uint32Array(1);

	let value = 0;
	do {
		crypto.getRandomValues(buffer);
		value = buffer[0] ?? 0;
	} while (value >= limit);

	return min + (value % range);
}

/** Modular-crypt prefixes Bun.password emits (argon2id default, bcrypt/scrypt supported). */
const HASH_PREFIX_REGEX = /^\$[a-z0-9]/i;

/**
 * Profile PINs are hashed at rest with Bun.password (argon2id). Returns
 * `undefined` for an absent PIN so callers can spread it into a partial update
 * without clearing.
 */
export async function hashProfilePin(pin: string | undefined | null): Promise<string | undefined> {
	if (!pin) return undefined;

	return await password.hash(pin);
}

/**
 * Verifies a PIN against its stored value. Legacy plaintext PINs (stored before
 * hashing was introduced) are compared directly; anything hash-shaped that
 * fails to verify is rejected — never silently downgraded to a plaintext match.
 */
export async function verifyProfilePin(storedPin: string, providedPin: string): Promise<boolean> {
	if (HASH_PREFIX_REGEX.test(storedPin)) {
		try {
			return await password.verify(providedPin, storedPin);
		} catch {
			return false;
		}
	}

	return storedPin === providedPin;
}
