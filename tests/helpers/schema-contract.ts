/**
 * TypeBox JSON-schema tree walkers shared by contract tests.
 *
 * They deliberately avoid `Value.Check`-style validation: the honesty bugs we
 * guard against (a route model declaring fewer relations than the handler
 * returns, or vice versa) pass validation freely because `ProjectedResponseSchema`
 * deep-partials everything. Comparing declared property *trees* is what catches them.
 */

function mergeInto(target: Set<string>, source: Set<string>): void {
	for (const path of source) target.add(path);
}

function collectCompositePaths(schema: object, prefix: string): Set<string> {
	const paths = new Set<string>();
	const containers: unknown[][] = [];
	if ("allOf" in schema && Array.isArray(schema.allOf)) containers.push(schema.allOf);

	if ("anyOf" in schema && Array.isArray(schema.anyOf)) containers.push(schema.anyOf);

	if ("oneOf" in schema && Array.isArray(schema.oneOf)) containers.push(schema.oneOf);

	for (const container of containers) {
		for (const entry of container) mergeInto(paths, collectPropertyPaths(entry, prefix));
	}

	return paths;
}

/**
 * Collects every property path declared by a (possibly composite/projected)
 * schema: `library`, `library.id`, `videoStreams`, ... Relations appear as
 * prefixes with their children beneath them.
 */
export function collectPropertyPaths(schema: unknown, prefix = ""): Set<string> {
	if (Array.isArray(schema)) {
		const merged = new Set<string>();
		for (const entry of schema) mergeInto(merged, collectPropertyPaths(entry, prefix));

		return merged;
	}

	if (!(schema instanceof Object)) return new Set();

	const paths = new Set<string>();
	if ("properties" in schema && schema.properties instanceof Object) {
		for (const [key, value] of Object.entries(schema.properties)) {
			const path = prefix === "" ? key : `${prefix}.${key}`;
			paths.add(path);
			mergeInto(paths, collectPropertyPaths(value, path));
		}
	}

	mergeInto(paths, collectCompositePaths(schema, prefix));
	if ("items" in schema) mergeInto(paths, collectPropertyPaths(schema.items, prefix));

	return paths;
}

/** True when any schema reachable from the tree declares a property named `key`. */
export function schemaDeclaresProperty(schema: unknown, key: string): boolean {
	if (Array.isArray(schema)) return schema.some((entry) => schemaDeclaresProperty(entry, key));

	if (!(schema instanceof Object)) return false;

	const properties = "properties" in schema ? schema.properties : undefined;
	if (properties instanceof Object && key in properties) return true;

	return Object.values(schema).some((value) => schemaDeclaresProperty(value, key));
}
