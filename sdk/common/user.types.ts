import { t } from "elysia";
import { EntitySchema } from "./schema-utils";

export const UserSchema = EntitySchema(
	t.Object({
		id: t.String(),
		name: t.String(),
		email: t.String(),
		emailVerified: t.Boolean(),
		image: t.Nullable(t.String()),
		role: t.String(),
		banned: t.Boolean(),
		banReason: t.Nullable(t.String()),
		banExpires: t.Nullable(t.Date()),
		twoFactorEnabled: t.Boolean(),
	}),
);

export type User = typeof UserSchema.static;
