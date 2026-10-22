import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testRoot = join(tmpdir(), `reelvault-tests-${process.pid}`);

process.env.NODE_ENV = "test";
process.env.APP_PORT = "3030";
process.env.ROOT_DIR = testRoot;
process.env.DB_FILE_NAME = "reelvault-tests.sqlite";
process.env.BETTER_AUTH_SECRET ??= "test-secret-with-at-least-32-characters";

// PIDs are reused across runs; without a clean root a leftover migrated DB from
// an earlier process makes isolated stub-table suites fail intermittently.
rmSync(testRoot, { recursive: true, force: true });
mkdirSync(testRoot, { recursive: true });

// Better Auth's own user writes create the first profile, as at boot. Imported
// after the environment above is set, because the auth config reads it.
const { registerAuthListeners } = await import("../src/services/auth/auth.service");
registerAuthListeners();
