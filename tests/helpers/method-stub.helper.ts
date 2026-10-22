export interface MethodStub {
	readonly calls: unknown[][];
	restore(): void;
}

/**
 * Replaces a method on a (singleton) object with `impl`, recording every call.
 * The `never[]` rest parameter accepts impls of any signature. Test-local
 * monkey-patching of singletons — always pair with `restore()` in an
 * afterEach, or track stubs in an `activeStubs` array restored collectively.
 * Restore the array in reverse (`activeStubs.splice(0).toReversed()`): a stub stacked
 * on another stub of the same method saved that stub as its original, so restoring
 * the earlier one first leaves the later stub installed for the rest of the process.
 */
export function stubMethod(target: object, method: string, impl: (...args: never[]) => unknown): MethodStub {
	const original = Reflect.get(target, method) as unknown;
	// A stub of a method the target does not have replaces nothing: the test would
	// pass while the code it means to steer runs untouched. Fail at the stub instead.
	if (typeof original !== "function") throw new TypeError(`stubMethod: ${method} is not a method of the target`);
	const calls: unknown[][] = [];
	Reflect.set(target, method, (...args: never[]) => {
		calls.push([...args]);

		return impl(...args);
	});

	return {
		calls,
		restore: () => {
			Reflect.set(target, method, original);
		},
	};
}
