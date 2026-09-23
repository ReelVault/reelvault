import { t } from "elysia";

export const mediaMarkerTypes = ["intro", "credits", "recap", "chapter", "highlight"] as const;

export type MediaMarkerType = (typeof mediaMarkerTypes)[number];

export const mediaMarkerSources = ["automatic", "manual", "plugin"] as const;

export const MediaMarkerSchema = t.Object({
	id: t.String(),
	mediaFileId: t.String(),
	type: t.Union([t.Literal("intro"), t.Literal("credits"), t.Literal("recap"), t.Literal("chapter"), t.Literal("highlight")]),
	startSeconds: t.Number({ minimum: 0 }),
	endSeconds: t.Number({ minimum: 0 }),
	label: t.Nullable(t.String()),
	source: t.Union([t.Literal("automatic"), t.Literal("manual"), t.Literal("plugin")]),
	pluginId: t.Nullable(t.String()),
	createdAt: t.String(),
	updatedAt: t.String(),
});

export type MediaMarker = typeof MediaMarkerSchema.static;

export const CreateMediaMarkerSchema = t.Object({
	type: t.Union([t.Literal("intro"), t.Literal("credits"), t.Literal("recap"), t.Literal("chapter"), t.Literal("highlight")]),
	startSeconds: t.Number({ minimum: 0 }),
	endSeconds: t.Number({ minimum: 0 }),
	label: t.Optional(t.String()),
	source: t.Optional(t.Union([t.Literal("automatic"), t.Literal("manual"), t.Literal("plugin")])),
	pluginId: t.Optional(t.String()),
});

export type CreateMediaMarker = typeof CreateMediaMarkerSchema.static;

export const SetMediaMarkersSchema = t.Object({
	markers: t.Array(CreateMediaMarkerSchema),
});
