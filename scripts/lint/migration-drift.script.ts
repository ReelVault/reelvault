/**
 * Fails when the Drizzle schema has changes that no migration captures. drizzle-kit generates into a
 * copy of the migrations folder, so the check never writes a migration into the repository.
 */
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const MIGRATIONS = join(ROOT, "src/integrations/drizzle-orm/migrations");
const SCHEMAS = "./src/integrations/drizzle-orm/schemas/**/*.schema.ts";

/** The migration folders drizzle-kit adds to a copy of the migrations; empty when the schema has no drift. */
async function generatedMigrations(copy: string): Promise<string[]> {
	await cp(MIGRATIONS, copy, { recursive: true });
	const before = new Set(await readdir(copy));
	const generate = Bun.spawn({
		cmd: [
			process.execPath,
			"x",
			"--bun",
			"drizzle-kit",
			"generate",
			"--dialect",
			"sqlite",
			"--schema",
			SCHEMAS,
			"--out",
			copy,
			"--name",
			"drift",
		],
		cwd: ROOT,
		stdout: "ignore",
		stderr: "inherit",
	});
	if ((await generate.exited) !== 0) throw new Error("drizzle-kit generate failed");

	return (await readdir(copy)).filter((entry) => !before.has(entry));
}

const copy = await mkdtemp(join(tmpdir(), "reelvault-drift-"));
try {
	const drift = await generatedMigrations(copy);
	if (drift.length > 0) {
		console.error('Schema drift: the schema has changes no migration captures. Run `bun run db:generate --name "..."` and commit it.');
		process.exitCode = 1;
	} else {
		console.log("No schema drift.");
	}
} finally {
	await rm(copy, { recursive: true, force: true });
}
