// Reusable open-addressing table for bigram frequencies — synchronous and never
// re-entered, so no Map hashing or per-comparison allocation is needed.
const HASH_LOAD_FACTOR = 4;
let hashCapacity = 256;
let hashKeys = new Int32Array(hashCapacity);
let hashCounts = new Int32Array(hashCapacity);
let hashUsed = new Uint8Array(hashCapacity);

/** Encodes adjacent non-space code-unit pairs into 32-bit codes, without substring allocation. */
export function writeBigramCodes(value: string, out: number[]): void {
	out.length = 0;
	let previous = -1;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code === 32) continue;

		if (previous >= 0) out.push(previous * 65536 + code);

		previous = code;
	}

	// Mirror the old single-character fallback with a distinct marker code, so two
	// one-character titles still match each other (and neither matches a real bigram).
	if (out.length === 0 && previous >= 0) out.push(-1 - previous);
}

/** Sørensen–Dice coefficient over two bigram code lists, returns 0..1. */
export function bigramDice(codesA: readonly number[], codesB: readonly number[]): number {
	if (codesA.length === 0 || codesB.length === 0) return 0;

	ensureHashCapacity(codesA.length + codesB.length);
	const mask = hashCapacity - 1;
	hashUsed.fill(0);

	for (const code of codesB) bigramHashInsert(code, mask);

	let matches = 0;
	for (const code of codesA) if (bigramHashConsume(code, mask)) matches += 1;

	return (2 * matches) / (codesA.length + codesB.length);
}

function ensureHashCapacity(needed: number): void {
	if (needed * HASH_LOAD_FACTOR <= hashCapacity) return;

	let capacity = hashCapacity;
	while (capacity < needed * HASH_LOAD_FACTOR) capacity <<= 1;

	hashCapacity = capacity;
	hashKeys = new Int32Array(capacity);
	hashCounts = new Int32Array(capacity);
	hashUsed = new Uint8Array(capacity);
}

function hashCode(code: number, mask: number): number {
	return (Math.imul(code, 2654435761) >>> 0) & mask;
}

function bigramHashInsert(code: number, mask: number): void {
	let index = hashCode(code, mask);
	for (;;) {
		if ((hashUsed[index] ?? 0) === 0) {
			hashUsed[index] = 1;
			hashKeys[index] = code;
			hashCounts[index] = 1;

			return;
		}

		if ((hashKeys[index] ?? 0) === code) {
			hashCounts[index] = (hashCounts[index] ?? 0) + 1;

			return;
		}

		index = (index + 1) & mask;
	}
}

/** Decrements the stored count when `code` is present with a positive count. */
function bigramHashConsume(code: number, mask: number): boolean {
	let index = hashCode(code, mask);
	for (;;) {
		if ((hashUsed[index] ?? 0) === 0) return false;

		if ((hashKeys[index] ?? 0) === code) {
			const count = hashCounts[index] ?? 0;
			if (count <= 0) return false;

			hashCounts[index] = count - 1;

			return true;
		}

		index = (index + 1) & mask;
	}
}
