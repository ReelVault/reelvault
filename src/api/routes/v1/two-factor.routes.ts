import { Elysia, t } from "elysia";
import { commonModel, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { twoFactorService } from "@/application/auth/two-factor.service";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";
import { MINUTE } from "@/server.constants";

const MANAGEMENT_WINDOW_MS = 15 * MINUTE;
const VERIFY_WINDOW_MS = 5 * MINUTE;

export const twoFactorRoutes = new Elysia({
	prefix: "/auth/two-factor",
	tags: ["Auth", "TwoFactor"],
})
	.use(commonModel)
	.use(rateLimitMiddleware)
	.post("/enable", async ({ request, body }) => await twoFactorService.enable(request.headers, body.password), {
		body: t.Object({ password: t.String({ minLength: 1 }) }),
		response: { ...ROUTE_ERRORS.VALIDATED },
		rateLimit: { name: "two-factor:enable", max: 10, windowMs: MANAGEMENT_WINDOW_MS },
	})
	.post("/disable", async ({ request, body }) => await twoFactorService.disable(request.headers, body.password), {
		body: t.Object({ password: t.String({ minLength: 1 }) }),
		response: { ...ROUTE_ERRORS.VALIDATED },
		rateLimit: { name: "two-factor:disable", max: 10, windowMs: MANAGEMENT_WINDOW_MS },
	})
	.post("/verify-totp", async ({ request, body }) => await twoFactorService.verifyTotp(request.headers, body.code), {
		body: t.Object({ code: t.String({ minLength: 6 }) }),
		response: { ...ROUTE_ERRORS.VALIDATED },
		// TOTP is a 6-digit secret — throttle brute force hard.
		rateLimit: { name: "two-factor:verify-totp", max: 5, windowMs: VERIFY_WINDOW_MS },
	})
	.post("/verify-backup-code", async ({ request, body }) => await twoFactorService.verifyBackupCode(request.headers, body.code), {
		body: t.Object({ code: t.String({ minLength: 1 }) }),
		response: { ...ROUTE_ERRORS.VALIDATED },
		rateLimit: { name: "two-factor:verify-backup-code", max: 5, windowMs: VERIFY_WINDOW_MS },
	})
	.post("/generate-backup-codes", async ({ request, body }) => await twoFactorService.generateBackupCodes(request.headers, body.password), {
		body: t.Object({ password: t.String({ minLength: 1 }) }),
		response: { ...ROUTE_ERRORS.VALIDATED },
		rateLimit: { name: "two-factor:generate-backup-codes", max: 10, windowMs: MANAGEMENT_WINDOW_MS },
	});
