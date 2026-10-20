import { joinPath } from "@/utils/path.utils";

/** Migration folders ship in the drizzle-orm integration (`src/integrations/drizzle-orm/migrations`). */
export const MIGRATIONS_DIR = joinPath(import.meta.dir, "..", "migrations");
