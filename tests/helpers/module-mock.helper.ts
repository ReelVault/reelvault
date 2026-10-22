import { mock } from "bun:test";
import { createRequire } from "node:module";
import { detach } from "@/utils/promise.utils";
import { isRecord } from "@/utils/type.utils";

const requireModule = createRequire(import.meta.url);

/**
 * The real exports of every module a test has replaced, copied before the first
 * replacement. `mock.restore()` does not undo a module mock in Bun, so this
 * snapshot is what puts a module back.
 */
const realExports = new Map<string, Record<string, unknown>>();

function snapshotRealExports(id: string): Record<string, unknown> {
	const known = realExports.get(id);
	if (known !== undefined) return known;
	const loaded: unknown = requireModule(id);
	const snapshot = isRecord(loaded) ? { ...loaded } : {};
	realExports.set(id, snapshot);
	return snapshot;
}

function registerModule(id: string, exports: Record<string, unknown>): void {
	const registration = mock.module(id, () => exports);
	// Bun types the registration as `void | Promise<void>`; a registration that fails must not surface as an unhandled rejection.
	if (registration instanceof Promise) detach(registration);
}

/**
 * Replaces a module with its real exports, overriding only the ones the test controls.
 *
 * Two hazards make a bare `mock.module` unsafe:
 *
 *  - `mock.module` rebinds the module's live exports, so a mock that calls
 *    back into the module it replaces recurses forever;
 *  - a mock that names only the exports it changes leaves every other export
 *    `undefined`, which breaks whatever the code under test imports next.
 *
 * The real exports are snapshotted before the first replacement and spread into
 * the replacement, so only the overridden exports behave differently. The
 * snapshot holds values, not live bindings: mock modules whose exports are
 * functions and constants, not mutable state.
 */
export function mockModuleWithRealExports(id: string, overrides: Record<string, unknown>): void {
	const real = snapshotRealExports(id);
	registerModule(id, { ...real, ...overrides });
}

/**
 * Puts every module replaced by `mockModuleWithRealExports` back to its real exports.
 *
 * Call it in `afterAll`, or in `afterEach` when one test replaces a module for
 * itself. Without it, a replacement stays in place for the rest of the file and,
 * when files share a process, for every file that runs after it.
 */
export function restoreModuleMocks(): void {
	for (const [id, real] of realExports) registerModule(id, real);
}
