import { join } from "node:path";
/** Migration folders ship in the drizzle-orm integration (`src/integrations/drizzle-orm/migrations`). */
export const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");
