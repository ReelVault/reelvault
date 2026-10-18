/** Recursively freezes an object graph so plugin hooks cannot mutate the candidate they were handed. */
export function deepFreeze<T>(value: T): Readonly<T> {
	if (value && typeof value === "object") {
		Object.freeze(value);
		for (const nested of Object.values(value)) deepFreeze(nested);
	}

	return value;
}
