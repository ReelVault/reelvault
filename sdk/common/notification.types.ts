import { t } from "elysia";
import { EntitySchema } from "./schema-utils";

export const NotificationSchema = EntitySchema(
	t.Object({
		id: t.String(),
		userId: t.String(),
		profileId: t.Nullable(t.String()),
		type: t.String(),
		title: t.String(),
		message: t.Nullable(t.String()),
		data: t.Record(t.String(), t.Unknown()),
		link: t.Nullable(t.String()),
		readAt: t.Nullable(t.Date()),
	}),
);

export type Notification = typeof NotificationSchema.static;

export const CreateNotificationSchema = t.Object({
	userId: t.String(),
	profileId: t.Optional(t.String()),
	type: t.String({ minLength: 1 }),
	title: t.String({ minLength: 1 }),
	message: t.Optional(t.String()),
	data: t.Optional(t.Record(t.String(), t.Unknown())),
	link: t.Optional(t.String()),
});

export type CreateNotification = typeof CreateNotificationSchema.static;
