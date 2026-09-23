import { t } from "elysia";

const TimestampSchema = t.Object({
	createdAt: t.Date(),
	updatedAt: t.Date(),
});

export const EntitySchema = <T extends Parameters<typeof t.Composite>[0][number]>(schema: T) => t.Composite([schema, TimestampSchema]);
