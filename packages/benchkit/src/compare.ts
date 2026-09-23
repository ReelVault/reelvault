export interface AbVariant {
	name: string;
	fn: () => unknown;
}

export interface AbResult {
	name: string;
	winner: string;
	rows: string[];
}

const NS_PER_MS = 1_000_000;

/**
 * Runs every variant `iterations` times, each iteration executing `batch`
 * inner calls, and reports ns per single call. Batching keeps the measured
 * operation above timer resolution — without it, sub-microsecond variants
 * measure mostly `performance.now()` overhead.
 */
export function abCompare(
	name: string,
	variants: readonly AbVariant[],
	options: { iterations?: number | undefined; batch?: number | undefined } = {},
): AbResult {
	const iterations = options.iterations ?? 200;
	const batch = options.batch ?? 1;
	const rows: string[] = [];
	let bestName = "";
	let bestNs = Number.POSITIVE_INFINITY;

	for (const variant of variants) {
		// Warmup.
		for (let i = 0; i < 50; i++) variant.fn();

		const times: number[] = [];
		for (let i = 0; i < iterations; i++) {
			const startedAt = performance.now();
			for (let j = 0; j < batch; j++) variant.fn();

			times.push(performance.now() - startedAt);
		}

		times.sort((a, b) => a - b);
		const medianMs = times[Math.floor(times.length / 2)] ?? 0;
		const nsPerOp = (medianMs / batch) * NS_PER_MS;
		if (nsPerOp < bestNs) {
			bestNs = nsPerOp;
			bestName = variant.name;
		}

		rows.push(variant.name);
		rows.push(`${nsPerOp.toFixed(0)} ns`);
	}

	return { name, winner: bestName, rows };
}

export interface CompareOutcome {
	result: AbResult;
	/** False when `equal` was provided and rejected the variant outputs — no winner is declared. */
	equalOk: boolean;
}

/**
 * Runs the A/B timing and, when `equal` is provided, verifies all variants
 * produce the same output (each variant is called once, outputs compared
 * against the first). A failed check suppresses the winner.
 */
export function compareVariants(
	name: string,
	variants: readonly AbVariant[],
	options: {
		iterations?: number | undefined;
		batch?: number | undefined;
		equal?: ((a: unknown, b: unknown) => boolean) | undefined;
	} = {},
): CompareOutcome {
	const equal = options.equal;
	if (!equal || variants.length < 2) {
		return { result: abCompare(name, variants, options), equalOk: true };
	}

	const outputs = variants.map((variant) => variant.fn());
	const first = outputs[0];
	let equalOk = true;
	for (let index = 1; index < outputs.length; index++) {
		if (!equal(first, outputs[index])) {
			equalOk = false;
			break;
		}
	}

	const result = abCompare(name, variants, options);
	if (!equalOk) result.winner = "";

	return { result, equalOk };
}

/** Prints one A/B section: name, per-variant ns/op rows, then the winner verdict. */
export function printAbResult(result: AbResult, equalOk = true): void {
	console.log(`\n${result.name}`);
	for (let index = 0; index < result.rows.length; index += 2) {
		const label = result.rows[index] ?? "";
		const value = result.rows[index + 1] ?? "";
		console.log(`  ${label.padEnd(28)} ${value}`);
	}

	if (!equalOk) {
		console.log("  → EQUALITY CHECK FAILED — variants produce different outputs, no winner declared");

		return;
	}

	console.log(`  → winner: ${result.winner}`);
}
