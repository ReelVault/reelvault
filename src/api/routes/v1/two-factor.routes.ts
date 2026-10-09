import { AuthUserSchema, TwoFactorBackupCodesStatusSchema } from "@reelvault/sdk/common";
import { Elysia, t } from "elysia";
import { commonModel, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { twoFactorService } from "@/application/auth/two-factor.service";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";
import { MINUTE } from "@/server.constants";

const MANAGEMENT_WINDOW_MS = 15 * MINUTE;
const VERIFY_WINDOW_MS = 5 * MINUTE;

/** Successful sign-in verification: the new session token (also set as a cookie) and the signed-in user. */
const TwoFactorSignInSchema = t.Object({ token: t.Nullable(t.String()), user: AuthUserSchema });

export const twoFactorRoutes = new Elysia({
	prefix: "/auth/two-factor",
	tags: ["Auth", "TwoFactor"],
})
	.use(commonModel)
	.use(rateLimitMiddleware)
	.get("/backup-codes", async ({ request }) => await twoFactorService.countRemainingBackupCodes(request.headers), {
		rateLimit: { name: "auth-two-factor-backup-codes", max: 30, windowMs: MANAGEMENT_WINDOW_MS },
		response: { 200: TwoFactorBackupCodesStatusSchema },
		detail: {
			description: "How many backup codes the signed-in account can still use. The codes themselves are never returned.",
		},
	})
	.post("/enable", async ({ request, body }) => await twoFactorService.enable(request.headers, body.password), {
		body: t.Object({ password: t.String({ minLength: 1 }) }),
		response: { ...ROUTE_ERRORS.VALIDATED, 200: t.Object({ totpURI: t.String(), backupCodes: t.Array(t.String()) }) },
		rateLimit: { name: "two-factor:enable", max: 10, windowMs: MANAGEMENT_WINDOW_MS },
		detail: {
			description:
				"Start enabling TOTP two-factor authentication: returns the otpauth URI to scan and one-time backup codes. Requires the account password.",
		},
	})
	.post("/disable", async ({ request, body }) => await twoFactorService.disable(request.headers, body.password), {
		body: t.Object({ password: t.String({ minLength: 1 }) }),
		response: { ...ROUTE_ERRORS.VALIDATED, 200: t.Object({ status: t.Literal(true) }) },
		rateLimit: { name: "two-factor:disable", max: 10, windowMs: MANAGEMENT_WINDOW_MS },
		detail: {
			description: "Turn off two-factor authentication. Requires the account password. Responds `{ status: true }` on success.",
		},
	})
	.post("/verify-totp", async ({ request, body }) => await twoFactorService.verifyTotp(request.headers, body.code), {
		body: t.Object({ code: t.String({ minLength: 6 }) }),
		response: { ...ROUTE_ERRORS.VALIDATED, 200: TwoFactorSignInSchema },
		// TOTP is a 6-digit secret — throttle brute force hard.
		rateLimit: { name: "two-factor:verify-totp", max: 5, windowMs: VERIFY_WINDOW_MS },
		detail: {
			description:
				"Verify a 6-digit authenticator code to finish enabling two-factor or to complete a two-factor sign-in. On sign-in the response carries the new session token and user, and the session cookie is set.",
		},
	})
	.post("/verify-backup-code", async ({ request, body }) => await twoFactorService.verifyBackupCode(request.headers, body.code), {
		body: t.Object({ code: t.String({ minLength: 1 }) }),
		response: { ...ROUTE_ERRORS.VALIDATED, 200: TwoFactorSignInSchema },
		rateLimit: { name: "two-factor:verify-backup-code", max: 5, windowMs: VERIFY_WINDOW_MS },
		detail: {
			description:
				"Complete a two-factor sign-in with one of the one-time backup codes. The response carries the new session token and user, and the session cookie is set. A used code stops working.",
		},
	})
	.post("/generate-backup-codes", async ({ request, body }) => await twoFactorService.generateBackupCodes(request.headers, body.password), {
		body: t.Object({ password: t.String({ minLength: 1 }) }),
		response: { ...ROUTE_ERRORS.VALIDATED, 200: t.Object({ backupCodes: t.Array(t.String()) }) },
		rateLimit: { name: "two-factor:generate-backup-codes", max: 10, windowMs: MANAGEMENT_WINDOW_MS },
		detail: { description: "Replace the backup codes with a fresh set (the old ones stop working). Requires the account password." },
	});
