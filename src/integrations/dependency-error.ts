import { InternalError } from "@/utils/errors";

/** A required media tool is missing; the code carries the tool names for the translated message. */
export class DependencyError extends InternalError {
	readonly missing: string[];

	constructor(missing: string[], message: string) {
		super(message, { code: "media_tools.missing", params: { tools: missing.join(", ") } });
		this.missing = missing;
	}
}
