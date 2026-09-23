import { type Static, t } from "elysia";

export const SystemSettingGroupSchema = t.Union([
	t.Literal("resources"),
	t.Literal("streaming"),
	t.Literal("scanning"),
	t.Literal("downloads"),
	t.Literal("markers"),
	t.Literal("trickplay"),
	t.Literal("images"),
	t.Literal("workers"),
	t.Literal("playback_defaults"),
	t.Literal("system"),
	t.Literal("network"),
]);

export const SystemSettingItemViewSchema = t.Object({
	key: t.String(),
	group: SystemSettingGroupSchema,
	type: t.String(),
	value: t.Any(),
	default: t.Any(),
	options: t.Optional(t.Array(t.String())),
	isCustom: t.Boolean(),
});

export type SystemSettingItemView = Static<typeof SystemSettingItemViewSchema>;

export const SystemSettingsGroupedSchema = t.Object({
	resources: t.Array(SystemSettingItemViewSchema),
	streaming: t.Array(SystemSettingItemViewSchema),
	scanning: t.Array(SystemSettingItemViewSchema),
	downloads: t.Array(SystemSettingItemViewSchema),
	markers: t.Array(SystemSettingItemViewSchema),
	trickplay: t.Array(SystemSettingItemViewSchema),
	images: t.Array(SystemSettingItemViewSchema),
	workers: t.Array(SystemSettingItemViewSchema),
	playback_defaults: t.Array(SystemSettingItemViewSchema),
	system: t.Array(SystemSettingItemViewSchema),
	network: t.Array(SystemSettingItemViewSchema),
});

export type SystemSettingsGrouped = Static<typeof SystemSettingsGroupedSchema>;

export const UpdateSystemSettingsSchema = t.Record(t.String(), t.Any());

export type UpdateSystemSettings = Static<typeof UpdateSystemSettingsSchema>;

export const ResetSystemSettingsSchema = t.Object({
	keys: t.Optional(t.Array(t.String())),
});

export type ResetSystemSettings = Static<typeof ResetSystemSettingsSchema>;
