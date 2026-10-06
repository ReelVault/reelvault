import { Elysia } from "elysia";
import { commonModel } from "@/api/schemas/common.schemas";
import { authMiddleware } from "@/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";

/**
 * Shared shell for admin route modules: shared models, session derive,
 * per-route rate-limit macro and the `adminOnly` guard, applied before the
 * module's own routes.
 *
 * A builder rather than a used plugin on purpose: Elysia guard scopes do not
 * propagate through `.use()`, so a plugin carrying the guard would silently
 * drop the adminOnly check. Routes registered on the returned instance inherit
 * it, exactly like the per-file chain it replaces. commonModel stays here (not
 * on admin.routes.ts) because Elysia resolves model-name references per
 * instance at the type level — a parent-only registration is a check-types
 * error in every module.
 */
export function adminShell<const Prefix extends string = "">(options?: { prefix?: Prefix; tags?: string[] }) {
	return new Elysia(options).use(commonModel).use(authMiddleware).use(rateLimitMiddleware).guard({ adminOnly: true });
}
