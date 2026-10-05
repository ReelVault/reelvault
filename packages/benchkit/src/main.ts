import { printUsage, suiteArgs } from "./args";
import { runFile, stemOf } from "./runner";

/**
 * The one-line file tail: outside standalone execution this is a no-op (the
 * discovery runner drives the units), standalone it prints usage on --help or
 * runs the calling file's registered units.
 *
 *   await main(import.meta);
 */
export async function main(meta: ImportMeta, options: { usageLabel?: string } = {}): Promise<void> {
	if (!meta.main) return;

	const args = suiteArgs();
	if (args.saveBaseline !== undefined || args.compareBaseline !== undefined) {
		console.warn("[benchkit] baseline flags are supported by `bun run benchmark` only — ignoring");
	}

	const stem = stemOf(meta.path);
	if (args.help) {
		printUsage(options.usageLabel ?? `benchmark ${stem}`);

		return;
	}

	await runFile(meta);
}
