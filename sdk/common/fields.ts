type Split<S extends string> = S extends `${infer Head},${infer Tail}` ? Head | Split<Tail> : S;
type SubPath<Path, Key extends string> = Path extends `${Key}.${infer Rest}` ? Rest : never;

type FieldPathValue<Value> =
	Value extends ReadonlyArray<infer Item>
		? Item extends object
			? FieldPath<Item>
			: never
		: Value extends Date
			? never
			: Value extends object
				? FieldPath<Value>
				: never;

export type FieldPath<T> =
	T extends ReadonlyArray<infer Item>
		? Item extends object
			? FieldPath<Item>
			: never
		: T extends Date
			? never
			: T extends object
				? {
						[K in keyof T & string]: K | (FieldPathValue<T[K]> extends never ? never : `${K}.${FieldPathValue<T[K]>}`);
					}[keyof T & string]
				: never;

type JoinPaths<Paths extends readonly string[], Result extends string = ""> = Paths extends readonly [
	infer Head extends string,
	...infer Tail extends string[],
]
	? JoinPaths<Tail, Result extends "" ? Head : `${Result},${Head}`>
	: Result;

type ParseFields<T, Paths extends string> =
	T extends Array<infer U>
		? Array<ParseFields<U, Paths>>
		: T extends object
			? {
					// Selected keys are required because they must exist in the response.
					[K in keyof T as K extends (Paths extends `${infer P}.${string}` ? P : Paths) ? K : never]-?: K extends Paths
						? T[K]
						: "*" extends SubPath<Paths, K & string>
							? // Preserve null while removing only undefined.
								T[K] extends infer V
								? V extends undefined
									? never
									: V
								: never
							:
									| ParseFields<T[K] extends infer V ? (V extends undefined ? never : V) : unknown, SubPath<Paths, K & string>>
									| (null extends T[K] ? null : never);
				}
			: T;

export type SelectFields<T, S extends string | undefined> = S extends undefined
	? T
	: S extends string
		? string extends S
			? T
			: ParseFields<T, Split<S>>
		: never;

export type RequireFields<T, S extends string> = ParseFields<T, Split<S>>;

/**
 * `join` produces a plain string at runtime; the comma-joined literal union is
 * re-claimed at this single boundary so `SelectFields`/`RequireFields` receive
 * the exact paths type.
 */
function assertJoinedPaths<Paths extends readonly string[]>(_value: string, _witness?: Partial<Paths>): asserts _value is JoinPaths<Paths> {
	// Runtime strings are not verifiable against the literal union.
}

/**
 * Creates a readable, autocomplete-friendly field query while preserving the
 * exact comma-separated literal type expected by SelectFields/RequireFields.
 */
export function defineFields<T>() {
	return <const Paths extends ReadonlyArray<FieldPath<T>>>(...paths: Paths): JoinPaths<Paths> => {
		const joined = paths.join(",");
		assertJoinedPaths<Paths>(joined);

		return joined;
	};
}

export interface FieldsConfig<F extends string = string> {
	fields: string[];
	relations: Record<string, string[]>;
	__original?: F | undefined;
}

export interface FieldsQuery<F extends string = string> {
	fields?: F | undefined;
}
