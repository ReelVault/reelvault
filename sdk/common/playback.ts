import { t } from "elysia";

export const playbackArtifactKinds = ["trickplay", "chapters", "preview", "waveform"] as const;

export type PlaybackArtifactKind = (typeof playbackArtifactKinds)[number];

export const PlaybackArtifactSchema = t.Object({
	id: t.String(),
	mediaFileId: t.String(),
	pluginId: t.String(),
	kind: t.Union([t.Literal("trickplay"), t.Literal("chapters"), t.Literal("preview"), t.Literal("waveform")]),
	url: t.String(),
	contentType: t.String(),
	createdAt: t.String({ format: "date-time" }),
});

export type PlaybackArtifact = typeof PlaybackArtifactSchema.static;

export interface PlaybackArtifactWrite {
	mediaFileId: string;
	kind: PlaybackArtifactKind;
	contentType: string;
	content: Blob | Uint8Array;
}
