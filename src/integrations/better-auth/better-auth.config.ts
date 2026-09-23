import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { admin, openAPI, twoFactor } from "better-auth/plugins";
import { databaseFactory } from "@/database/database";
import { profilesRepository } from "@/database/repositories/profiles.repository";
import { schema } from "@/database/schema";
import { env } from "@/env";
import { serverConfig } from "@/server.config";
import { CLIENT_IP_HEADER } from "@/utils/client-ip.utils";
import { getTrustedOriginPatterns, isOriginAllowed, normalizeHttpUrl } from "@/utils/http.utils";
import { isRecord } from "@/utils/type.utils";

const publicUrl = env.APP_PUBLIC_URL ? normalizeHttpUrl(env.APP_PUBLIC_URL).toString() : undefined;
const baseUrl = publicUrl ?? `http://localhost:${env.APP_PORT}`;

export const auth = betterAuth({
	appName: serverConfig.auth.appName,
	baseURL: baseUrl,
	session: {
		cookieCache: {
			enabled: true,
			maxAge: 5 * 60,
		},
	},
	trustedOrigins: (request) => {
		const patterns = getTrustedOriginPatterns();
		if (!request) return patterns;

		const origin = request.headers.get("origin");
		if (origin && isOriginAllowed(origin)) {
			return [origin, ...patterns];
		}

		return patterns;
	},
	advanced: {
		database: {
			joins: true,
		},
		// Better Auth's own limiter (sign-in 5/min etc.) defaults to the first
		// X-Forwarded-For hop, which the client controls — read only the IP that
		// clientIpMiddleware resolved through the configured proxy trust.
		ipAddress: {
			ipAddressHeaders: [CLIENT_IP_HEADER],
		},
		useSecureCookies: serverConfig.auth.secureCookies,
		disableCSRFCheck: false,
		disableOriginCheck: false,
		defaultCookieAttributes: {
			httpOnly: true,
			secure: serverConfig.auth.secureCookies,
			sameSite: "lax",
		},
	},
	rateLimit: {
		enabled: serverConfig.auth.rateLimit.enabled,
		window: serverConfig.auth.rateLimit.windowSeconds,
		max: serverConfig.auth.rateLimit.max,
		customRules: {
			"/sign-in/email": {
				window: serverConfig.auth.rateLimit.emailSignIn.windowSeconds,
				max: serverConfig.auth.rateLimit.emailSignIn.max,
			},
			"/sign-up/email": {
				window: serverConfig.auth.rateLimit.emailSignUp.windowSeconds,
				max: serverConfig.auth.rateLimit.emailSignUp.max,
			},
		},
	},
	database: drizzleAdapter(databaseFactory.getClient(), {
		provider: "sqlite",
		schema: {
			user: schema.users,
			session: schema.sessions,
			account: schema.accounts,
			verification: schema.verifications,
			twoFactor: schema.twoFactors,
		},
	}),
	emailAndPassword: {
		enabled: serverConfig.auth.emailAndPasswordEnabled,
	},
	hooks: {
		before: createAuthMiddleware((ctx) => {
			let hookResult: { context: { body: Record<string, unknown> } } | undefined;
			if (ctx.path === "/change-password" && isRecord(ctx.body)) {
				// A changed password must invalidate every other device — a stolen
				// session would otherwise survive the very action meant to lock it out,
				// so the client-side opt-in flag is forced on server-side.
				hookResult = { context: { body: { ...ctx.body, revokeOtherSessions: true } } };
			}

			return Promise.resolve(hookResult);
		}),
	},
	databaseHooks: {
		user: {
			create: {
				after: async (user) => {
					await profilesRepository.insert({
						values: {
							userId: user.id,
							name: user.name,
						},
					});
				},
			},
		},
	},
	plugins: [
		admin({
			defaultRole: "user",
			adminRoles: ["admin"],
		}),
		twoFactor({
			issuer: serverConfig.auth.appName,
		}),
		openAPI(),
	],
});
