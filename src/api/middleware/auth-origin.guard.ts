import { DomainError } from "@/utils/domain.errors";
import { isOriginAllowed } from "@/utils/origin-trust.utils";

/**
 * Origin check for state-changing auth requests. Better Auth's own CSRF
 * middleware never runs because `auth.api.*` bypasses its HTTP router, leaving
 * SameSite alone as the defense; non-browser callers that omit Origin are
 * unaffected. Every auth route file applies this before registering routes, so
 * Origin-less cross-site form posts are refused.
 */
export function assertAuthRequestOrigin(request: Request): void {
	const method = request.method.toUpperCase();
	if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

	const origin = request.headers.get("origin");
	if (origin && !isOriginAllowed(origin)) {
		throw new DomainError("forbidden", "Request origin is not allowed", { code: "auth.origin_denied" });
	}
}
