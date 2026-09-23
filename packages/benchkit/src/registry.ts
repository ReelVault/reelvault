import type { AbVariant } from "./compare";

/** A registered benchmark unit awaiting execution by the runner. */
export interface BenchUnit {
	kind: "bench";
	group: string;
	name: string;
	fn: (context: { iteration: number }) => unknown;
	options: { warmup?: number; iterations?: number };
}

export interface CompareUnit {
	kind: "compare";
	name: string;
	variants: AbVariant[];
	equal?: ((a: unknown, b: unknown) => boolean) | undefined;
	options: { iterations?: number | undefined; batch?: number | undefined };
}

/** Returned by a task body; `ok: false` is a soft failure (fails only under --strict). */
export interface TaskOutcome {
	ok?: boolean;
	data?: unknown;
}

export interface TaskUnit {
	kind: "task";
	name: string;
	fn: () => unknown;
}

export type Unit = BenchUnit | CompareUnit | TaskUnit;

const units: Unit[] = [];
let currentGroup = "";

/** Labels the bench units registered inside — each label becomes one results table. */
export function group(name: string, register: () => void): void {
	currentGroup = name;
	register();
	currentGroup = "";
}

export interface BenchOptions {
	warmup?: number;
	iterations?: number;
}

/** Registers a micro-benchmark unit (measure/measureAsync semantics — per-iteration timing). */
export function bench(name: string, fn: (context: { iteration: number }) => unknown, options: BenchOptions = {}): void {
	units.push({ kind: "bench", group: currentGroup, name, fn, options });
}

export interface CompareConfig {
	/** Named variants, or an ordered AbVariant list. */
	variants: Record<string, () => unknown> | AbVariant[];
	/** Verifies all variants produce the same output; a failed check suppresses the winner. */
	equal?: (a: unknown, b: unknown) => boolean;
	iterations?: number;
	batch?: number;
}

/** Registers an A/B comparison unit over named variants of the same operation. */
export function compare(name: string, config: CompareConfig): void {
	const variants: AbVariant[] = Array.isArray(config.variants)
		? config.variants
		: Object.entries(config.variants).map(([variantName, fn]) => ({ name: variantName, fn }));
	units.push({
		kind: "compare",
		name,
		variants,
		equal: config.equal,
		options: { iterations: config.iterations, batch: config.batch },
	});
}

/** Registers a bespoke unit (load flows, audits, phased checks) that prints its own output. */
export function task(name: string, fn: () => unknown): void {
	units.push({ kind: "task", name, fn });
}

/** Marks the current registry depth — pass the value to collectUnits after the import. */
export function markCollection(): number {
	return units.length;
}

/** Removes and returns every unit registered since the given mark. */
export function collectUnits(mark: number): Unit[] {
	return units.splice(mark);
}

export interface FixtureHooks {
	onCleanup: (fn: () => void | Promise<void>) => void;
}

export type Fixture<T> = () => Promise<T>;

export interface FixtureCell {
	name: string;
	cleanups: Array<() => void | Promise<void>>;
}

const cells: FixtureCell[] = [];

/**
 * Lazy, shared fixture: setup runs at most once, on first use, and cleanups
 * run in reverse resolution order when the runner finishes the file.
 */
export function fixture<T>(name: string, setup: (hooks: FixtureHooks) => T | Promise<T>): Fixture<T> {
	const cell: FixtureCell = { name, cleanups: [] };
	let setupPromise: Promise<T> | undefined;

	return () => {
		if (!setupPromise) {
			cells.push(cell);
			setupPromise = (async () => {
				try {
					return await setup({ onCleanup: (fn) => cell.cleanups.push(fn) });
				} catch (error) {
					throw new Error(`[benchkit] fixture "${name}" setup failed`, { cause: error });
				}
			})();
		}

		return setupPromise;
	};
}

/** Tears down resolved fixtures in reverse order and forgets them. */
export async function cleanupFixtures(): Promise<void> {
	for (const cell of cells.toReversed()) {
		for (const fn of cell.cleanups.toReversed()) {
			await fn();
		}
	}

	cells.length = 0;
}
