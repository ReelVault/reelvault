import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";

export const users = sqliteTable("users", {
	id: DatabaseHelper.id,

	// Better Auth
	name: text("name").notNull(),
	email: text("email", { length: 255 }).notNull().unique(),
	emailVerified: integer("emailVerified", { mode: "boolean" }).notNull(),
	image: text("image"),

	// Better Auth - Admin
	role: text("role").notNull().default("user"),
	banned: integer("banned", { mode: "boolean" }).notNull().default(false),
	banReason: text("banReason"),
	banExpires: integer("banExpires", { mode: "timestamp" }),

	// Better Auth - Two Factor
	twoFactorEnabled: integer("twoFactorEnabled", { mode: "boolean" }).notNull().default(false),

	...DatabaseHelper.timestamps,
});

export const sessions = sqliteTable(
	"session",
	{
		id: DatabaseHelper.id,
		userId: DatabaseHelper.tableRef("userId", () => users.id, { onDelete: "cascade" }),

		// Better Auth
		token: text("token", { length: 255 }).notNull().unique(),
		ipAddress: text("ipAddress"),
		userAgent: text("userAgent"),

		// Better Auth - Admin
		impersonatedBy: text("impersonatedBy"),

		expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
		...DatabaseHelper.timestamps,
	},
	(table) => [
		index("session_user_idx").on(table.userId),
		index("session_expires_idx").on(table.expiresAt),
		index("session_user_expires_idx").on(table.userId, table.expiresAt),
		// Live-activity view filters by updatedAt and orders by it (no userId scope).
		index("session_updated_idx").on(table.updatedAt),
	],
);

export const accounts = sqliteTable(
	"account",
	{
		id: DatabaseHelper.id,
		userId: DatabaseHelper.tableRef("userId", () => users.id, { onDelete: "cascade" }),
		accountId: text("accountId").notNull(),
		providerId: text("providerId").notNull(),

		idToken: text("idToken"),
		accessToken: text("accessToken"),
		refreshToken: text("refreshToken"),

		scope: text("scope"),
		password: text("password"),

		accessTokenExpiresAt: integer("accessTokenExpiresAt", { mode: "timestamp" }),
		refreshTokenExpiresAt: integer("refreshTokenExpiresAt", { mode: "timestamp" }),
		...DatabaseHelper.timestamps,
	},
	(table) => [
		uniqueIndex("account_provider_account_unique").on(table.providerId, table.accountId),
		index("account_user_idx").on(table.userId),
	],
);

export const verifications = sqliteTable(
	"verification",
	{
		id: DatabaseHelper.id,

		identifier: text("identifier").notNull(),
		value: text("value").notNull(),

		expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
		...DatabaseHelper.timestamps,
	},
	(table) => [index("verification_identifier_idx").on(table.identifier), index("verification_expires_idx").on(table.expiresAt)],
);

export const twoFactors = sqliteTable(
	"twoFactor",
	{
		id: DatabaseHelper.id,
		userId: DatabaseHelper.tableRef("userId", () => users.id, { onDelete: "cascade" }),

		secret: text("secret").notNull(),
		backupCodes: text("backupCodes").notNull(),

		verified: integer("verified", { mode: "boolean" }).notNull().default(true),
		failedVerificationCount: integer("failedVerificationCount").notNull().default(0),

		lockedUntil: integer("lockedUntil", { mode: "timestamp" }),
	},
	(table) => [index("two_factor_user_idx").on(table.userId), index("two_factor_secret_idx").on(table.secret)],
);
