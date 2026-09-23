import { t } from "elysia";
import { EntitySchema } from "./schema-utils";

export const SessionSchema = EntitySchema(
	t.Object({
		id: t.String(),
		userId: t.String(),
		token: t.String(),
		ipAddress: t.Nullable(t.String()),
		userAgent: t.Nullable(t.String()),
		impersonatedBy: t.Nullable(t.String()),
		expiresAt: t.Date(),
	}),
);

export type Session = typeof SessionSchema.static;
