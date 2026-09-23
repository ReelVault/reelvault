import { type Static, type TSchema, t } from "elysia";

export type DeepPartial<T> = T extends Date
	? T
	: T extends ReadonlyArray<infer Item>
		? Array<DeepPartial<Item>>
		: T extends object
			? { [Key in keyof T]?: DeepPartial<T[Key]> }
			: T;

/** Extra schema members mutated while deep-partialling a TypeBox schema. */
interface PartialSchemaExtras {
	properties?: Record<string, TSchema> | undefined;
	items?: TSchema | undefined;
	anyOf?: TSchema[] | undefined;
	oneOf?: TSchema[] | undefined;
	allOf?: TSchema[] | undefined;
	required?: string[] | undefined;
}

/**
 * Deep-partialling a schema rewrites `properties`/`items`/... recursively at
 * runtime; TypeScript cannot express that transformation on the `static` side,
 * so the projected shape is claimed at this single boundary.
 */
function assertProjectedSchema<Schema extends TSchema>(
	_value: TSchema,
	_witness?: Partial<Schema>,
): asserts _value is TSchema & { static: DeepPartial<Static<Schema>> } {
	// Type-level projection of a runtime schema transformation.
}

function makeDeepPartial(schema: TSchema): TSchema {
	const partial: TSchema & PartialSchemaExtras = { ...schema };

	if (partial.properties) {
		partial.properties = Object.fromEntries(Object.entries(partial.properties).map(([key, property]) => [key, makeDeepPartial(property)]));
		const { required: _required, ...withoutRequired } = partial;

		return withoutRequired;
	}

	if (partial.items) partial.items = makeDeepPartial(partial.items);

	if (partial.anyOf) partial.anyOf = partial.anyOf.map(makeDeepPartial);

	if (partial.oneOf) partial.oneOf = partial.oneOf.map(makeDeepPartial);

	if (partial.allOf) partial.allOf = partial.allOf.map(makeDeepPartial);

	return partial;
}

/**
 * Response schema for endpoints supporting `fields`.
 *
 * Field projection can omit properties at every nesting level, so a regular
 * `t.Partial` is insufficient for relations such as `genres.id`.
 */
export const ProjectedResponseSchema = <Schema extends TSchema>(schema: Schema) => {
	const partial = makeDeepPartial(schema);
	assertProjectedSchema<Schema>(partial);

	return partial;
};

/**
 * Error envelope. `code` is a stable machine identifier and `params` carries the
 * interpolation values; the frontend owns all translated text. There is
 * deliberately no user-facing `message` field.
 */
export const ApiErrorResponseSchema = t.Object({
	statusCode: t.Integer({ minimum: 400, maximum: 599 }),
	code: t.String(),
	params: t.Optional(t.Record(t.String(), t.Union([t.String(), t.Number(), t.Boolean(), t.Null()]))),
	requestId: t.Optional(t.String()),
	details: t.Optional(t.Unknown()),
});

export type ApiErrorResponse = typeof ApiErrorResponseSchema.static;

export const SuccessResponseSchema = t.Object({
	success: t.Boolean(),
});

export type SuccessResponse = typeof SuccessResponseSchema.static;

export const PaginatedResponseSchema = <T extends TSchema>(item: T) =>
	t.Object({
		page: t.Integer({ minimum: 1 }),
		limit: t.Integer({ minimum: 1 }),
		total: t.Integer({ minimum: 0 }),
		totalPages: t.Integer({ minimum: 0 }),
		nextCursor: t.Optional(t.String()),
		data: t.Array(item, { default: [] }),
	});
