import { betterAuthApi } from "@/integrations/better-auth/better-auth.api";
import { UnauthorizedError, ValidationError } from "@/utils/errors";

/**
 * Thin pass-through to the better-auth two-factor plugin. Success responses are
 * returned raw (the plugin sets cookies while mutating 2FA state); failures are
 * re-thrown as DomainErrors so the client receives the standard error envelope
 * with a stable code instead of better-auth's own body shape.
 */
class TwoFactorService {
	enable(headers: Headers, password: string): Promise<Response> {
		return this.withErrorMapping(betterAuthApi.enableTwoFactor({ password, headers }), "auth.two_factor.invalid_password");
	}

	disable(headers: Headers, password: string): Promise<Response> {
		return this.withErrorMapping(betterAuthApi.disableTwoFactor({ password, headers }), "auth.two_factor.invalid_password");
	}

	verifyTotp(headers: Headers, code: string): Promise<Response> {
		return this.withErrorMapping(betterAuthApi.verifyTotp({ code, headers }), "auth.two_factor.invalid_code");
	}

	verifyBackupCode(headers: Headers, code: string): Promise<Response> {
		return this.withErrorMapping(betterAuthApi.verifyBackupCode({ code, headers }), "auth.two_factor.invalid_backup_code");
	}

	generateBackupCodes(headers: Headers, password: string): Promise<Response> {
		return this.withErrorMapping(betterAuthApi.generateBackupCodes({ password, headers }), "auth.two_factor.invalid_password");
	}

	private async withErrorMapping(pending: Promise<Response>, rejectionCode: string): Promise<Response> {
		const response = await pending;
		if (response.ok) return response;

		// Only the status carries over: 4xx from these endpoints means the
		// submitted secret (password / TOTP / backup code) was rejected, so each
		// caller maps to its own stable code. better-auth's message is dropped —
		// responses travel as code + params only.
		if (response.status === 401 || response.status === 403) {
			throw new UnauthorizedError(`Two-factor secret rejected (${response.status})`, { code: rejectionCode });
		}

		if (response.status >= 400 && response.status < 500) {
			throw new ValidationError("Two-factor request rejected", { code: rejectionCode });
		}

		throw new ValidationError("Two-factor request failed", { code: "auth.two_factor.failed" });
	}
}

export const twoFactorService = new TwoFactorService();
