export interface MethodStub {
	readonly calls: unknown[][];
	restore(): void;
}

/**
 * Replaces a method on a (singleton) object with `impl`, recording every call.
 * The `never[]` rest parameter accepts impls of any signature. Test-local
 * monkey-patching of singletons — always pair with `restore()` in an
 * afterEach, or track stubs in an `activeStubs` array restored collectively.
 */
export function stubMethod(target: object, method: string, impl: (...args: never[]) => unknown): MethodStub {
	const original = Reflect.get(target, method) as unknown;
	const calls: unknown[][] = [];
	Reflect.set(target, method, (...args: never[]) => {
		calls.push([...args]);

		return impl(...args);
	});

	return {
		calls,
		restore: () => {
			if (original === undefined) Reflect.deleteProperty(target, method);
			else Reflect.set(target, method, original);
		},
	};
}
