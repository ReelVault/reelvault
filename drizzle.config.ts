import { join } from "node:path";
import { defineConfig } from "drizzle-kit";
import { env } from "@/config/env.config";

export default defineConfig({
	out: "./src/integrations/drizzle-orm/migrations",
	schema: "./src/integrations/drizzle-orm/schemas/**/*.schema.ts",
	dialect: "sqlite",
	dbCredentials: {
		url: join(env.ROOT_DIR, env.DB_FILE_NAME),
	},
});
