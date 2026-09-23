import { which } from "bun";
import { DependencyError } from "./dependency-error";

/**
 * The binary for a given configured name cannot move while the process runs —
 * which() walks PATH on every call otherwise (one per spawn). Keyed by the
 * configured name because it is runtime-changeable.
 */
export function createBinaryAvailability(getPath: () => string, installHint: string) {
	let resolved: { requested: string; path: string } | undefined;

	return (findCommand?: (command: string) => string | null): string => {
		const requested = getPath();
		if (findCommand === undefined && resolved?.requested === requested) return resolved.path;

		const path = (findCommand ?? which)(requested);
		if (!path) throw new DependencyError([requested], `Missing required media tools: ${requested}. ${installHint}`);

		if (findCommand === undefined) resolved = { requested, path };

		return path;
	};
}
