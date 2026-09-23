import { ReelVaultValidationError } from "./errors";

interface ValidationOptions {
	method?: string | undefined;
	url?: string | undefined;
}

/**
 * Guards against missing path parameters: empty segments and the stringified
 * `undefined`/`null` that a `$(param)` interpolation would produce.
 */
export function assertValidPath(path: string, options: ValidationOptions = {}): void {
	const segments = path.split("/").filter((segment) => segment.length > 0);
	const empty = segments.some((segment) => segment === "undefined" || segment === "null");
	if (empty) {
		throw new ReelVaultValidationError([{ path: "(path)", message: `Path contains a missing parameter: ${path}`, value: path }], options);
	}
}
