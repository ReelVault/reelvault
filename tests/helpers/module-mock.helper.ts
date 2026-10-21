import { mock } from "bun:test";
import { createRequire } from "node:module";
import { detach } from "@/utils/promise.utils";
import { isRecord } from "@/utils/type.utils";

const requireModule = createRequire(import.meta.url);

/**
 * Registers a module mock and handles Bun's `void | Promise<void>` return.
 * Registration is synchronous in practice; the optional promise is detached so
 * a replacement never becomes an unhandled rejection.
 */
export function mockModule(id: string, factory: () => object): void {
	const registration = mock.module(id, factory);
	if (registration instanceof Promise) detach(registration);
}

/**
 * Registers a module mock that keeps every export the test does not control.
 *
 * Two hazards make a bare `mock.module` unsafe:
 *
 *  - `mock.module` rebinds the module's live exports, so a mock that calls
 *    back into the module it replaces recurses forever;
 *  - a mock that names only the exports it changes leaves every other export
 *    `undefined`, which breaks whatever the code under test imports next — and
 *    every test file that runs after it.
 *
 * The real exports are snapshotted before the mock lands and spread into the
 * replacement, so only the overridden exports behave differently.
 */
export function mockModuleWithRealExports(id: string, overrides: Record<string, unknown>): void {
	const loaded: unknown = requireModule(id);
	const real = isRecord(loaded) ? loaded : {};
	mockModule(id, () => ({ ...real, ...overrides }));
}

/**
 * Restores every module mock.
 *
 * Call it in `afterAll`: Bun loads the test files one at a time, so the
 * restore always runs before the next file is loaded and the next file gets
 * the real module.
 */
export function restoreModuleMocks(): void {
	mock.restore();
}
