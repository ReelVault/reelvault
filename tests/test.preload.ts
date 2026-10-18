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

// Modules read their data through ports the application registers at boot. Wire the
// same implementations once per test process, after the environment above is set.
const { wireModulePorts } = await import("../src/app/wiring/module-ports");
wireModulePorts();
const { wireWorkerPorts } = await import("../src/app/wiring/worker-ports");
wireWorkerPorts();
const { wireSystemPorts } = await import("../src/app/wiring/system-ports");
wireSystemPorts();
const { wireIntegrationPorts } = await import("../src/app/wiring/integration-ports");
wireIntegrationPorts();
