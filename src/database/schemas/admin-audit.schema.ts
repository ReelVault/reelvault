import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { users } from "./auth.schema";

export const adminAuditLogs = sqliteTable(
	"admin_audit_logs",
	{
		id: DatabaseHelper.id,
		actorUserId: DatabaseHelper.nullableTableRef("actor_user_id", () => users.id, { onDelete: "set null" }),

		action: text("action", { enum: ["create", "update", "delete"] }).notNull(),

		resourceType: text("resource_type").notNull(),
		resourceId: text("resource_id"),
		resourceName: text("resource_name"),
		summary: text("summary"),

		beforeJson: text("before_json"),
		afterJson: text("after_json"),

		requestId: text("request_id"),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),

		...DatabaseHelper.timestamps,
	},
	(table) => [
		index("admin_audit_actor_created_idx").on(table.actorUserId, table.createdAt),
		index("admin_audit_action_created_idx").on(table.action, table.createdAt),
		index("admin_audit_resource_created_idx").on(table.resourceType, table.resourceId, table.createdAt),
		index("admin_audit_created_id_idx").on(table.createdAt, table.id),
		index("admin_audit_request_idx").on(table.requestId),
		index("admin_audit_ip_idx").on(table.ipAddress),
	],
);
