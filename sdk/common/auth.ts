import { t } from "elysia";
import { PaginatedResponseSchema } from "./api";
import type { PaginatedResponse } from "./pagination";

export const RegisterRequestSchema = t.Object({
	email: t.String({ format: "email" }),
	password: t.String({ minLength: 8 }),
	username: t.String({ minLength: 3 }),
});

export type RegisterRequest = typeof RegisterRequestSchema.static;

export const SetupAdminRequestSchema = t.Object({
	name: t.String({ minLength: 1 }),
	email: t.String({ format: "email" }),
	password: t.String({ minLength: 8 }),
});

export type SetupAdminRequest = typeof SetupAdminRequestSchema.static;

export const SetupStatusSchema = t.Object({
	required: t.Boolean(),
	// Whether POST /setup expects the x-setup-token header (SETUP_TOKEN_ENABLED=true).
	tokenRequired: t.Boolean(),
});

export type SetupStatus = typeof SetupStatusSchema.static;

export const LoginRequestSchema = t.Object({
	email: t.String({ format: "email" }),
	password: t.String(),
});

export type LoginRequest = typeof LoginRequestSchema.static;

export const AuthUserSchema = t.Object({
	id: t.String(),
	name: t.String(),
	email: t.String({ format: "email" }),
	emailVerified: t.Boolean(),
	image: t.Nullable(t.String()),
	role: t.String(),
	twoFactorEnabled: t.Boolean(),
	createdAt: t.String({ format: "date-time" }),
	updatedAt: t.String({ format: "date-time" }),
});

export type AuthUser = typeof AuthUserSchema.static;

export const AuthSessionSchema = t.Object(
	{
		id: t.String(),
		userId: t.String(),
		expiresAt: t.String({ format: "date-time" }),
		createdAt: t.String({ format: "date-time" }),
		updatedAt: t.String({ format: "date-time" }),
	},
	{ additionalProperties: false },
);

export type AuthSession = typeof AuthSessionSchema.static;

export const ActiveSessionSchema = t.Object({
	id: t.String(),
	ipAddress: t.Nullable(t.String()),
	userAgent: t.Nullable(t.String()),
	createdAt: t.String({ format: "date-time" }),
	updatedAt: t.String({ format: "date-time" }),
	expiresAt: t.String({ format: "date-time" }),
	isCurrent: t.Boolean(),
});

export type ActiveSession = typeof ActiveSessionSchema.static;

export const ActiveSessionsResponseSchema = PaginatedResponseSchema(ActiveSessionSchema);

export type ActiveSessionsResponse = PaginatedResponse<ActiveSession>;

export const AuthProfileSchema = t.Object(
	{
		id: t.String(),
		userId: t.String(),
		name: t.String(),
		avatarUrl: t.Nullable(t.String()),
		createdAt: t.String({ format: "date-time" }),
		updatedAt: t.String({ format: "date-time" }),
	},
	{ additionalProperties: false },
);

export type AuthProfile = typeof AuthProfileSchema.static;

export const RegisterResponseSchema = t.Object({
	token: t.Nullable(t.String()),
	user: AuthUserSchema,
});

export type RegisterResponse = typeof RegisterResponseSchema.static;

export const LoginResponseSchema = t.Object({
	token: t.String(),
	user: AuthUserSchema,
	redirect: t.Boolean(),
	url: t.Optional(t.String()),
	twoFactorRedirect: t.Optional(t.Boolean()),
	twoFactorMethods: t.Optional(t.Array(t.String())),
});

export type LoginResponse = typeof LoginResponseSchema.static;

export const LogoutResponseSchema = t.Object({
	success: t.Boolean(),
});

export type LogoutResponse = typeof LogoutResponseSchema.static;

export const SessionResponseSchema = t.Object({
	session: t.Nullable(AuthSessionSchema),
	user: t.Nullable(AuthUserSchema),
	profile: t.Nullable(AuthProfileSchema),
});

export type SessionResponse = typeof SessionResponseSchema.static;

export const QuickConnectInitiateResponseSchema = t.Object({
	code: t.String(),
	secret: t.String(),
	expiresIn: t.Number(),
});

export type QuickConnectInitiateResponse = typeof QuickConnectInitiateResponseSchema.static;

export const QuickConnectCheckResponseSchema = t.Object({
	authenticated: t.Boolean(),
	token: t.Optional(t.String()),
	user: t.Optional(AuthUserSchema),
	redirect: t.Optional(t.Boolean()),
});

export type QuickConnectCheckResponse = typeof QuickConnectCheckResponseSchema.static;

export const QuickConnectAuthorizeRequestSchema = t.Object({
	code: t.String({ minLength: 4, maxLength: 32 }),
});

export const QuickConnectGenerateResponseSchema = t.Object({
	code: t.String(),
	expiresIn: t.Number(),
});

export type QuickConnectGenerateResponse = typeof QuickConnectGenerateResponseSchema.static;

export const QuickConnectRedeemRequestSchema = t.Object({
	code: t.String({ minLength: 4, maxLength: 32 }),
});
