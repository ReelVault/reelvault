import { mock } from "bun:test";
import { detach } from "@/utils/promise.utils";

/**
 * Registers a module mock and handles Bun's `void | Promise<void>` return.
 * Registration is synchronous in practice; the optional promise is detached so
 * a replacement never becomes an unhandled rejection.
 */
export function mockModule(id: string, factory: () => object): void {
	const registration = mock.module(id, factory);
	if (registration instanceof Promise) detach(registration);
}
