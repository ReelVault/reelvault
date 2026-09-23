export class DependencyError extends Error {
	readonly missing: string[];

	constructor(missing: string[], message: string) {
		super(message);
		this.name = "DependencyError";
		this.missing = missing;
	}
}
