import { DomainError } from "@/utils/errors";

/** A required media tool is missing; the code carries the tool names for the translated message. */
export class DependencyError extends DomainError {
	readonly missing: string[];

	constructor(missing: string[], message: string) {
		super("internal", message, { code: "media_tools.missing", params: { tools: missing.join(", ") } });
		this.missing = missing;
	}
}
