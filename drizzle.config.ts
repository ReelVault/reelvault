import { join } from "node:path";
import { defineConfig } from "drizzle-kit";
import { env } from "@/env";

export default defineConfig({
	out: "./src/database/migrations",
	schema: "./src/database/schemas/**/*.schema.ts",
	dialect: "sqlite",
	dbCredentials: {
		url: join(env.ROOT_DIR, env.DB_FILE_NAME),
	},
});
