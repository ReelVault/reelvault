import { bench, main, suiteArgs } from "benchkit";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import { upsertRows } from "@/integrations/drizzle-orm/query/table-access/writes.writer";

/**
 * The shared `upsertRows` must be no slower than the hand-written
 * `onConflictDoUpdate` it replaced. Both variants target the same row(s) on the
 * isolated benchmark database; the warm-up ensures the statement cache is hot.
 */
export const meta = { description: "Insert-or-update: shared upsertRows vs raw onConflictDoUpdate (single and batch)" };

const settings = defineTableAccess("systemSettings", { primaryKeyColumn: "key" });
const SINGLE_KEY = "bench:upsert:single";
const BATCH_SIZE = 50;
const batchKeys = Array.from({ length: BATCH_SIZE }, (_, index) => `bench:upsert:batch:${index}`);

const args = suiteArgs();

if (!args.help) {
	databaseFactory.migrate();
	const client = databaseFactory.getClient();
	let sequence = 0;

	await client
		.insert(schema.systemSettings)
		.values([{ key: SINGLE_KEY, value: "0" }, ...batchKeys.map((key) => ({ key, value: "0" }))])
		.onConflictDoNothing();

	bench(
		"upsert: raw single onConflictDoUpdate",
		async () => {
			sequence++;
			await client
				.insert(schema.systemSettings)
				.values({ key: SINGLE_KEY, value: String(sequence) })
				.onConflictDoUpdate({
					target: schema.systemSettings.key,
					set: { value: String(sequence), updatedAt: new Date() },
				});
		},
		{ warmup: 20, iterations: args.iterations },
	);

	bench(
		"upsert: shared upsertRows single",
		async () => {
			sequence++;
			await upsertRows(settings, {
				values: { key: SINGLE_KEY, value: String(sequence) },
				target: schema.systemSettings.key,
			});
		},
		{ warmup: 20, iterations: args.iterations },
	);

	const batchIterations = Math.max(20, Math.floor(args.iterations / 4));

	bench(
		"upsert: raw batch onConflictDoUpdate (50)",
		async () => {
			sequence++;
			await client
				.insert(schema.systemSettings)
				.values(batchKeys.map((key) => ({ key, value: String(sequence) })))
				.onConflictDoUpdate({
					target: schema.systemSettings.key,
					set: { value: String(sequence), updatedAt: new Date() },
				});
		},
		{ warmup: 10, iterations: batchIterations },
	);

	bench(
		"upsert: shared upsertRows batch (50)",
		async () => {
			sequence++;
			await upsertRows(settings, {
				values: batchKeys.map((key) => ({ key, value: String(sequence) })),
				target: schema.systemSettings.key,
			});
		},
		{ warmup: 10, iterations: batchIterations },
	);
}

await main(import.meta);
