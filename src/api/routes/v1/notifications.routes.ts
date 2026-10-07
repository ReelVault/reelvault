import { NotificationSchema } from "@reelvault/sdk/common";
import { Elysia, t } from "elysia";
import { ClampedNumeric, commonModel, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { IdParams } from "@/api/schemas/route-params";
import { notificationsService } from "@/application/notifications/notifications.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { cached } from "@/middleware/response-cache.middleware";

export const notificationsRoutes = new Elysia({ prefix: "/notifications", tags: ["Notifications"] })
	.use(commonModel)
	.use(authMiddleware)
	.model({
		"notifications.unread-count.response": t.Object({ count: t.Integer({ minimum: 0 }) }),
		"notifications.update-status.body": t.Object({
			ids: t.Optional(t.Array(t.String(), { maxItems: 500 })),
			all: t.Optional(t.Boolean()),
			read: t.Optional(t.Boolean()),
		}),
	})
	.guard({ auth: true })
	.get("/", async ({ query, user, profile }) => await notificationsService.getAll(user?.id, profile?.id, query.unreadOnly, query.limit), {
		query: t.Object({
			unreadOnly: t.Optional(t.BooleanString()),
			limit: t.Optional(ClampedNumeric(1, 200)),
		}),
		response: { ...ROUTE_ERRORS.AUTH, 200: t.Array(NotificationSchema) },
		...cached({ maxAge: 10, private: true }),
		detail: { description: "Retrieve notifications for authenticated account and profile. Optional limit trims the result." },
	})
	.get("/unread-count", async ({ user, profile }) => await notificationsService.getUnreadCount(user?.id, profile?.id), {
		response: { ...ROUTE_ERRORS.AUTH, 200: "notifications.unread-count.response" },
		detail: { description: "Count of unread notifications." },
	})
	.patch("/", async ({ body, user, profile }) => await notificationsService.updateStatus(body, user?.id, profile?.id), {
		body: "notifications.update-status.body",
		response: { ...ROUTE_ERRORS.AUTH, 200: "success.response" },
		detail: { description: "Batch update notification read status." },
	})
	.patch(
		"/:id",
		async ({ params, body, user, profile }) => await notificationsService.markRead(params.id, user?.id, profile?.id, body?.read ?? true),
		{
			params: IdParams,
			body: t.Optional(t.Object({ read: t.Optional(t.Boolean()) })),
			response: { ...ROUTE_ERRORS.AUTH, 403: "error.response", 200: "success.response" },
			detail: { description: "Set a notification's read state (defaults to read)." },
		},
	);
