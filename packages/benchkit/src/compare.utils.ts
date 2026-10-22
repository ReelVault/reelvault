export interface AbVariant {
	name: string;
	fn: () => unknown;
}

export interface CompareVariantResult {
	name: string;
	/** Median time of one call, in nanoseconds. */
	nsPerOp: number;
}

export interface CompareOutcome {
	name: string;
	/** The fastest variant; empty when the equality check failed. */
	winner: string;
	/** False when `equal` rejected the variants' outputs — no winner is declared then. */
	equalOk: boolean;
	variants: CompareVariantResult[];
}

export interface CompareOptions {
	/** Timed rounds per variant (default 200). */
	iterations?: number | undefined;
	/** Calls per timing; keeps sub-microsecond operations above the timer's resolution (default 1). */
	batch?: number | undefined;
	/** Verifies every variant produces the first variant's output. */
	equal?: ((a: unknown, b: unknown) => boolean) | undefined;
}

const NS_PER_MS = 1_000_000;
const WARMUP_ROUNDS = 50;
const DEFAULT_ROUNDS = 200;

function median(sortedTimes: readonly number[]): number {
	return sortedTimes[Math.floor(sortedTimes.length / 2)] ?? 0;
}

/** Calls every variant once and compares each output with the first; true without `equal`. */
function outputsMatch(variants: readonly AbVariant[], equal: CompareOptions["equal"]): boolean {
	const [first, ...rest] = variants;
	if (!(equal && first)) return true;

	const expected = first.fn();

	return rest.every((variant) => equal(expected, variant.fn()));
}

/**
 * Times named variants of one operation against each other. The variants run in interleaved rounds —
 * every round times each variant once, in an order that rotates per round — so drift during the run
 * (JIT tiers, thermal throttling, GC pressure) lands on all of them alike instead of on whichever ran
 * last. Each timing covers `batch` calls; a variant's result is the median round per call.
 */
export function compareVariants(name: string, variants: readonly AbVariant[], options: CompareOptions = {}): CompareOutcome {
	const equalOk = outputsMatch(variants, options.equal);
	const rounds = options.iterations ?? DEFAULT_ROUNDS;
	const batch = options.batch ?? 1;

	for (let round = 0; round < WARMUP_ROUNDS; round++) {
		for (const variant of variants) variant.fn();
	}

	const times = variants.map((): number[] => []);
	for (let round = 0; round < rounds; round++) {
		for (let offset = 0; offset < variants.length; offset++) {
			const index = (round + offset) % variants.length;
			const variant = variants[index];
			if (!variant) continue;

			const startedAt = performance.now();
			for (let call = 0; call < batch; call++) variant.fn();
			times[index]?.push(performance.now() - startedAt);
		}
	}

	const results = variants.map((variant, index) => ({
		name: variant.name,
		nsPerOp: (median((times[index] ?? []).toSorted((left, right) => left - right)) / batch) * NS_PER_MS,
	}));
	const fastest = results.toSorted((left, right) => left.nsPerOp - right.nsPerOp)[0];

	return { name, winner: equalOk ? (fastest?.name ?? "") : "", equalOk, variants: results };
}

/** Prints one A/B section: per-variant ns/op with its factor against the fastest, then the verdict. */
export function printAbResult(outcome: CompareOutcome): void {
	const fastestNs = Math.min(...outcome.variants.map((variant) => variant.nsPerOp));
	console.log(`\n${outcome.name}`);
	for (const variant of outcome.variants) {
		const factor = fastestNs > 0 ? `×${(variant.nsPerOp / fastestNs).toFixed(2)}` : "";
		console.log(`  ${variant.name.padEnd(28)} ${`${variant.nsPerOp.toFixed(0)} ns`.padStart(12)}  ${factor}`);
	}

	if (!outcome.equalOk) {
		console.log("  → EQUALITY CHECK FAILED — variants produce different outputs, no winner declared");

		return;
	}

	console.log(`  → winner: ${outcome.winner}`);
}
