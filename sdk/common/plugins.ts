import { t } from "elysia";

export const PluginLifecycleStateSchema = t.Union([
	t.Literal("discovered"),
	t.Literal("validated"),
	t.Literal("resolved"),
	t.Literal("initialized"),
	t.Literal("enabled"),
	t.Literal("disabled"),
	t.Literal("failed"),
	t.Literal("unloaded"),
]);

export type PluginLifecycleState = typeof PluginLifecycleStateSchema.static;

export const PluginLoadPhaseSchema = t.Union([
	t.Literal("manifest"),
	t.Literal("config"),
	t.Literal("entry"),
	t.Literal("import"),
	t.Literal("setup"),
	t.Literal("initialization"),
	t.Literal("activation"),
]);

export type PluginLoadPhase = typeof PluginLoadPhaseSchema.static;

/** A safe administrative view of one plugin runtime, with no configuration values. */
export const PluginRuntimeStatusSchema = t.Object({
	id: t.String(),
	name: t.String(),
	version: t.String(),
	description: t.Optional(t.String()),
	state: PluginLifecycleStateSchema,
	providers: t.Integer({ minimum: 0 }),
	subtitleProviders: t.Integer({ minimum: 0 }),
	jobs: t.Integer({ minimum: 0 }),
	error: t.Optional(t.String()),
	failurePhase: t.Optional(PluginLoadPhaseSchema),
});

export type PluginRuntimeStatus = typeof PluginRuntimeStatusSchema.static;

/** Redacted plugin configuration values exposed to administrators. */

export const PluginConfigFieldOptionSchema = t.Object({
	label: t.String(),
	value: t.Union([t.String(), t.Number()]),
});

export const PluginConfigFieldSchema = t.Object({
	name: t.String(),
	type: t.Union([t.Literal("string"), t.Literal("number"), t.Literal("boolean"), t.Literal("select"), t.Literal("secret")]),
	label: t.String(),
	description: t.Optional(t.String()),
	default: t.Optional(t.Unknown()),
	required: t.Optional(t.Boolean()),
	min: t.Optional(t.Number()),
	max: t.Optional(t.Number()),
	step: t.Optional(t.Number()),
	options: t.Optional(t.Array(PluginConfigFieldOptionSchema)),
});

export const PluginConfigDetailsSchema = t.Object({
	id: t.String(),
	name: t.String(),
	version: t.String(),
	description: t.Optional(t.String()),
	config: t.Record(t.String(), t.Unknown()),
	fields: t.Array(PluginConfigFieldSchema),
});

export type PluginConfigDetails = typeof PluginConfigDetailsSchema.static;

export const UpdatePluginConfigBodySchema = t.Record(t.String(), t.Unknown());
