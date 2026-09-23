import { t } from "elysia";
import { EntitySchema } from "./schema-utils";

export const ImageSchema = EntitySchema(
	t.Object({
		id: t.String(),
		stableKey: t.String(),
		localPath: t.String(),
		contentType: t.String(),
		width: t.Nullable(t.Integer({ minimum: 1 })),
		height: t.Nullable(t.Integer({ minimum: 1 })),
		fileSize: t.Nullable(t.Integer({ minimum: 0 })),
		optimizationVersion: t.Nullable(t.Integer({ minimum: 0 })),
	}),
);

export type Image = typeof ImageSchema.static;
