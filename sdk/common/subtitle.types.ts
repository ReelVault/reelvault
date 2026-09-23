import { t } from "elysia";
import { EntitySchema } from "./schema-utils";

export const SubtitleEntitySchema = EntitySchema(
	t.Object({
		id: t.String(),
		mediaFileId: t.String(),
		language: t.String(),
		label: t.Nullable(t.String()),
		format: t.String(),
		type: t.Union([t.Literal("external"), t.Literal("embedded")]),
		filePath: t.Nullable(t.String()),
		streamIndex: t.Nullable(t.Integer({ minimum: 0 })),
		isDefault: t.Boolean(),
		isForced: t.Boolean(),
		isHearingImpaired: t.Boolean(),
	}),
);

export type SubtitleEntity = typeof SubtitleEntitySchema.static;
