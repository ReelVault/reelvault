import type {
	AuthProfile,
	AuthSession,
	AuthUser,
	ChangePasswordRequest,
	LoginRequest,
	Profile,
	RegisterRequest,
	Session,
	SessionResponse,
	User,
} from "@reelvault/sdk/common";
import { firstRunSetupService } from "@/app/auth/setup/first-run-setup.service";
import { usersRepository } from "@/app/repositories/users.repository";
import { serverConfig } from "@/config/server/server.config";
import { betterAuthApi } from "@/integrations/better-auth/better-auth.api";
import { toAuthFailure } from "@/integrations/better-auth/better-auth.failures";
import { rewriteCookieDomain } from "@/utils/cookie-domain.utils";
import { assertFound, DomainError } from "@/utils/domain.errors";
import { InMemoryRateLimiter } from "@/utils/in-memory.limiter";
import { createLogger } from "@/utils/logger.utils";
import { runSafely } from "@/utils/safe-execute.utils";
import { serializeDate } from "@/utils/time.utils";
import { normalizeLower } from "@/utils/type.utils";

const LOGIN_ACCOUNT_WINDOW_MS = 5 * 60_000;
/** Per-account throttle: the route-level limiter is per-IP, which distributed
 * attempts against one account can sidestep. Ceiling configurable for soak
 * tests via REELVAULT_LOGIN_ACCOUNT_MAX_ATTEMPTS (see env.ts). */
const loginAccountLimiter = new InMemoryRateLimiter();

class AuthService {
	readonly serviceName = "AuthService";
	readonly logger = createLogger("AuthService");

	async register(body: RegisterRequest, request: Request): Promise<Response> {
		return await runSafely(this, "register", async () => {
			const response = await firstRunSetupService.registerUser({
				email: body.email,
				password: body.password,
				name: body.username,
			});

			if (!response.ok) throw await toAuthFailure(response);

			return rewriteCookieDomain(response, request.headers.get("origin"));
		});
	}

	async changePassword(body: ChangePasswordRequest, request: Request): Promise<Response> {
		return await runSafely(this, "changePassword", async () => {
			const response = await betterAuthApi.changePassword({
				currentPassword: body.currentPassword,
				newPassword: body.newPassword,
				headers: request.headers,
			});
			if (!response.ok) throw await toAuthFailure(response, "auth.invalid_current_password");

			return rewriteCookieDomain(response, request.headers.get("origin"));
		});
	}

	async login(body: LoginRequest, request: Request): Promise<Response> {
		return await runSafely(this, "login", async () => {
			const accountKey = `login:${normalizeLower(body.email.trim())}`;
			const result = loginAccountLimiter.consume(accountKey, serverConfig.auth.loginAccountMaxAttempts, LOGIN_ACCOUNT_WINDOW_MS);
			if (!result.allowed) {
				throw new DomainError("too_many_requests", "Too many login attempts for this account.", {
					code: "rate_limit.exceeded",
					params: { retryAfterSeconds: Math.ceil(result.resetMs / 1000) },
				});
			}

			// Instance-wide policy: an account without configured TOTP cannot sign
			// in while enforcement is on. Checked before credential verification so
			// the rejection never depends on the password being right.
			if (serverConfig.auth.enforceTwoFactor) {
				const user = await usersRepository.findByEmail(body.email.trim());
				if (user && !user.twoFactorEnabled) {
					throw new DomainError("forbidden", "Two-factor authentication is required for this account", {
						code: "auth.two_factor_required",
					});
				}
			}

			const response = await betterAuthApi.signInEmail({
				email: body.email,
				password: body.password,
			});

			// better-auth answers with English prose; translate every failure (wrong credentials,
			// blocked account, ...) into a stable code the frontend can show.
			if (!response.ok) throw await toAuthFailure(response);

			// Typos before a correct password must not eat into the next sign-in's attempts.
			loginAccountLimiter.reset(accountKey);

			return rewriteCookieDomain(response, request.headers.get("origin"));
		});
	}

	async logout(request: Request): Promise<Response> {
		return await runSafely(this, "logout", async () => {
			assertFound(request.headers, "Auth", "logout");

			const response = await betterAuthApi.signOut(request.headers);

			return rewriteCookieDomain(response, request.headers.get("origin"));
		});
	}

	getMe(session?: Session | null, user?: User | null, profile?: Profile | null): Promise<SessionResponse> {
		return runSafely(this, "getMe", () => ({
			session: session ? toPublicSession(session) : null,
			user: user ? toPublicUser(user) : null,
			profile: profile ? toPublicProfile(profile) : null,
		}));
	}
}

export const authService = new AuthService();

function toPublicSession(session: Session): AuthSession {
	return {
		id: session.id,
		userId: session.userId,
		expiresAt: serializeDate(session.expiresAt),
		createdAt: serializeDate(session.createdAt),
		updatedAt: serializeDate(session.updatedAt),
	};
}

export function toPublicUser(user: User): AuthUser {
	return {
		id: user.id,
		name: user.name,
		email: user.email,
		emailVerified: user.emailVerified,
		image: user.image,
		role: user.role,
		twoFactorEnabled: user.twoFactorEnabled,
		createdAt: serializeDate(user.createdAt),
		updatedAt: serializeDate(user.updatedAt),
	};
}

function toPublicProfile(profile: Profile): AuthProfile {
	return {
		id: profile.id,
		userId: profile.userId,
		name: profile.name,
		avatarUrl: profile.avatarUrl,
		createdAt: serializeDate(profile.createdAt),
		updatedAt: serializeDate(profile.updatedAt),
	};
}
