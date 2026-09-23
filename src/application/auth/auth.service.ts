import type {
	AuthProfile,
	AuthSession,
	AuthUser,
	LoginRequest,
	Profile,
	RegisterRequest,
	Session,
	SessionResponse,
	User,
} from "@reelvault/sdk/common";
import { firstRunSetupService } from "@/application/auth/setup/first-run-setup.service";
import { betterAuthApi } from "@/integrations/better-auth/better-auth.api";
import { InMemoryRateLimiter } from "@/middleware/rate-limit.middleware";
import { serverConfig } from "@/server.config";
import { BaseService } from "@/utils/base-service";
import { TooManyRequestsError, UnauthorizedError } from "@/utils/errors";
import { rewriteCookieDomain } from "@/utils/http.utils";
import { serializeDate } from "@/utils/time.utils";
import { normalizeLower } from "@/utils/type.utils";

const LOGIN_ACCOUNT_WINDOW_MS = 5 * 60_000;
/** Per-account throttle: the route-level limiter is per-IP, which distributed
 * attempts against one account can sidestep. Ceiling configurable for soak
 * tests via REELVAULT_LOGIN_ACCOUNT_MAX_ATTEMPTS (see env.ts). */
const loginAccountLimiter = new InMemoryRateLimiter();

class AuthService extends BaseService {
	constructor() {
		super("AuthService");
	}

	async register(body: RegisterRequest, request: Request): Promise<Response> {
		return await this.safeExecute("register", async () => {
			const response = await firstRunSetupService.registerUser({
				email: body.email,
				password: body.password,
				name: body.username,
			});

			return rewriteCookieDomain(response, request.headers.get("origin"));
		});
	}

	async login(body: LoginRequest, request: Request): Promise<Response> {
		return await this.safeExecute("login", async () => {
			const accountKey = `login:${normalizeLower(body.email.trim())}`;
			const result = loginAccountLimiter.consume(accountKey, serverConfig.auth.rateLimit.loginAccountMaxAttempts, LOGIN_ACCOUNT_WINDOW_MS);
			if (!result.allowed) {
				throw new TooManyRequestsError("Too many login attempts for this account.", {
					code: "rate_limit.exceeded",
					params: { retryAfterSeconds: Math.ceil(result.resetMs / 1000) },
				});
			}

			const response = await betterAuthApi.signInEmail({
				email: body.email,
				password: body.password,
			});

			// better-auth's 401 body carries no stable machine code — tag it here so
			// the frontend can show "invalid credentials" instead of a generic 401.
			if (response.status === 401) {
				throw new UnauthorizedError("Invalid email or password", { code: "auth.invalid_credentials" });
			}

			return rewriteCookieDomain(response, request.headers.get("origin"));
		});
	}

	async logout(request: Request): Promise<Response> {
		return await this.safeExecute("logout", async () => {
			this.assertExists(request.headers, "Auth", "logout");

			const response = await betterAuthApi.signOut(request.headers);

			return rewriteCookieDomain(response, request.headers.get("origin"));
		});
	}

	getMe(session?: Session | null, user?: User | null, profile?: Profile | null): Promise<SessionResponse> {
		return this.safeExecute("getMe", () => ({
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
