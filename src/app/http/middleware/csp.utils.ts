const CSP_WHITESPACE_PATTERN = /\s+/;

/**
 * Appends plugin-declared sources to a Content-Security-Policy string. Existing
 * directives keep their values and position; a directive the policy does not
 * define yet is added at the end.
 */
export function appendCspSources(policy: string, sources: Readonly<Record<string, readonly string[]>>): string {
	const additions = Object.entries(sources).filter(([, values]) => values.length > 0);
	if (additions.length === 0) return policy;

	const directives = new Map<string, string[]>();
	for (const segment of policy.split(";")) {
		const [name, ...values] = segment.trim().split(CSP_WHITESPACE_PATTERN);
		if (name) directives.set(name, values);
	}

	for (const [name, values] of additions) {
		directives.set(name, [...(directives.get(name) ?? []), ...values]);
	}

	return [...directives].map(([name, values]) => [name, ...values].join(" ")).join("; ");
}
