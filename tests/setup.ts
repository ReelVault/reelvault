import { mkdirSync, rmSync } from "node:fs";

const testRoot = `/tmp/reelvault-tests-${process.pid}`;

process.env.NODE_ENV = "test";
process.env.APP_PORT = "3030";
process.env.ROOT_DIR = testRoot;
process.env.DB_FILE_NAME = "reelvault-tests.sqlite";

// PIDs are reused across runs; without a clean root a leftover migrated DB from
// an earlier process makes isolated stub-table suites fail intermittently.
rmSync(testRoot, { recursive: true, force: true });
mkdirSync(testRoot, { recursive: true });
