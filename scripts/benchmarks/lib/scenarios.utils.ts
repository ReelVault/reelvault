import type { ScenarioMatrixEntry, ScenarioWork } from "benchkit";

/** A suite-local scenario row: display name plus the context-bound request builder. */
export interface NamedScenario<C> {
	name: string;
	builder: (context: C, workerIndex: number, requestIndex: number) => Request;
}

export interface ScenarioEntryOptions<C, S extends NamedScenario<C>> {
	/** Success predicate shared by the request entries; defaults to `response.ok`. */
	accept?: ((response: Response) => boolean) | undefined;
	/** Multi-request work replacing `builder` for specific scenarios (e.g. pairs). */
	workFor?: ((scenario: S, context: C) => ScenarioWork | undefined) | undefined;
}

/**
 * Binds a suite's context to its named request builders — the `name + requestFor`
 * matrix entry every HTTP suite repeats, plus optional custom work and accept.
 */
export function toScenarioEntries<C, S extends NamedScenario<C>>(
	scenarios: readonly S[],
	context: C,
	options: ScenarioEntryOptions<C, S> = {},
): ScenarioMatrixEntry[] {
	return scenarios.map((scenario) => {
		const work = options.workFor?.(scenario, context);
		if (work) return { name: scenario.name, work };

		return {
			name: scenario.name,
			requestFor: (workerIndex, requestIndex) => scenario.builder(context, workerIndex, requestIndex),
			...(options.accept ? { accept: options.accept } : {}),
		};
	});
}
