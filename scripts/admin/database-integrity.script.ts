import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";

/** The unhealthy lines reported by `PRAGMA quick_check`; an empty list means the file is sound. */
export function quickCheckProblems(): string[] {
	return databaseFactory.sqlite
		.query("PRAGMA quick_check")
		.values()
		.map((row) => String(row[0]))
		.filter((line) => line !== "ok");
}
