import { PathUtils } from "@/utils/path.utils";

/** Migration folders ship in the drizzle-orm integration (`src/integrations/drizzle-orm/migrations`). */
export const MIGRATIONS_DIR = PathUtils.join(import.meta.dir, "..", "migrations");
