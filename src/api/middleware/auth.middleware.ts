import type { User } from "@reelvault/sdk/common";
import { Elysia } from "elysia";
import { isImageAssetPath, isPluginUiPath, isWebAssetPath } from "@/api/utils/route-classification.utils";
import { serverConstants } from "@/config/server/server.constants";
import { type ResolvedSession, sessionResolver } from "@/services/auth/session-resolver.service";
import { DomainError } from "@/utils/domain.errors";
import { getNormalizedPathname } from "@/utils/http.utils";
import { createLogger } from "@/utils/logger.utils";

const logger = createLogger("AuthMiddleware");

/**
 * GET prefixes that are public by design (rate limiter exempts them too).
 * The derive is global, so without this early-out every poster/backdrop request
 * paid full session verification + profile lookup — a catalog grid loads
 * dozens of images per view, each carrying the session cookie.
 */
const PLUGIN_UI_MANIFEST_PATH = `${serverConstants.security.pluginUiRoutePrefix}manifest`;

function isPublicGet(request: Request): boolean {
	if (request.method !== "GET") return false;

	const path = getNormalizedPathname(request);
	if (isImageAssetPath(path)) return true;

	// The SPA's own asset bundle: a page load pulls dozens of hashed chunks,
	// and they carry no user data — the session lookup they would trigger is
	// pure overhead on every one of them.
	if (isWebAssetPath(path)) return true;

	// Plugin UI assets are static bundle files (secret-free) imported cross-origin
	// as ESM modules — browsers omit credentials on those requests. The manifest
	// stays authenticated (it is role-filtered), as do plugin API routes.
	return isPluginUiPath(path) && path !== PLUGIN_UI_MANIFEST_PATH;
}

export const authMiddleware = new Elysia({ name: "AuthMiddleware" })
	.derive(
		{ as: "global" },
		// The context is spelled as a mapped type: Elysia's `derive` needs an index
		// signature, which an interface does not carry, and the middleware must not
		// repeat the shape the session resolver owns.
		async ({ request, cookie: { current_profile_id, profile_unlock } }): Promise<{ [K in keyof ResolvedSession]: ResolvedSession[K] }> => {
			if (isPublicGet(request)) {
				return sessionResolver.anonymous();
			}

			// Machine integration keys short-circuit before better-auth: the key is
			// its own credential and the principal is the admin who created it.
			const apiKeyHeader = request.headers.get("x-api-key");
			if (apiKeyHeader?.startsWith("rv_")) {
				return await sessionResolver.fromApiKey(request, apiKeyHeader, current_profile_id?.value, profile_unlock?.value);
			}

			if (!sessionResolver.hasCredentials(request.headers)) {
				return sessionResolver.anonymous();
			}

			return await sessionResolver.fromSessionCookie(request, current_profile_id?.value, profile_unlock?.value);
		},
	)

	.macro({
		auth: (required: boolean) => ({
			beforeHandle({ user }) {
				if (required) requireUser(user);
			},
		}),
		adminOnly: (required: boolean) => ({
			beforeHandle({ user }) {
				if (!required) return;

				requireUser(user);
				if (user.role !== "admin") {
					logger.debug("Admin access required");
					throw new DomainError("forbidden", "Admin access required", { code: "auth.admin_required" });
				}
			},
		}),
		profileRequired: (required: boolean) => ({
			beforeHandle({ user, profile }) {
				if (!required) return;

				requireUser(user);
				if (!profile) {
					logger.debug("Active profile required");
					throw new DomainError("unauthorized", "Active profile required", { code: "auth.profile_required" });
				}
			},
		}),
	});

export function requireUser(user: User | null): asserts user is User {
	if (!user) {
		logger.debug("Session expired or invalid");
		throw new DomainError("unauthorized", "Session expired or invalid", { code: "auth.session_invalid" });
	}
}

/** Narrows the derived user for handler bodies after the `adminOnly` macro guard. */
export function requireAdmin(user: User | null): asserts user is User {
	requireUser(user);
	if (user.role !== "admin") {
		logger.debug("Admin access required");
		throw new DomainError("forbidden", "Admin access required", { code: "auth.admin_required" });
	}
}
