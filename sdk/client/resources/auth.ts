import type {
	ActiveSessionsResponse,
	LoginRequest,
	LoginResponse,
	LogoutResponse,
	QuickConnectCheckResponse,
	QuickConnectGenerateResponse,
	QuickConnectInitiateResponse,
	RegisterRequest,
	RegisterResponse,
} from "@sdk/common";

import type { PaginationQuery } from "@sdk/common/pagination";
import { BaseResource } from "../core/base-client";

export class AuthClient extends BaseResource {
	listSessions(query?: PaginationQuery): Promise<ActiveSessionsResponse> {
		return this._get("/auth/sessions", { query });
	}

	revokeSession(sessionId: string): Promise<{ success: boolean }> {
		return this._delete(`/auth/sessions/${sessionId}`);
	}

	revokeOtherSessions(): Promise<{ success: boolean }> {
		return this._delete("/auth/sessions");
	}

	register(body: RegisterRequest): Promise<RegisterResponse> {
		return this._post("/auth/register", { body });
	}

	login(body: LoginRequest): Promise<LoginResponse> {
		return this._post(`/auth/login`, { body });
	}

	logout(): Promise<LogoutResponse> {
		return this._post(`/auth/logout`, { body: undefined });
	}

	// Two-factor authentication (proxied to better-auth under /v1/auth/two-factor).
	enableTwoFactor(password: string): Promise<{ totpURI: string; backupCodes: string[] }> {
		return this._post("/auth/two-factor/enable", { body: { password } });
	}

	disableTwoFactor(password: string): Promise<{ success: boolean }> {
		return this._post("/auth/two-factor/disable", { body: { password } });
	}

	verifyTotp(code: string): Promise<{ success: boolean }> {
		return this._post("/auth/two-factor/verify-totp", { body: { code } });
	}

	verifyBackupCode(code: string): Promise<{ success: boolean }> {
		return this._post("/auth/two-factor/verify-backup-code", { body: { code } });
	}

	generateBackupCodes(password: string): Promise<{ backupCodes: string[] }> {
		return this._post("/auth/two-factor/generate-backup-codes", { body: { password } });
	}

	// Quick Connect / Quick Login
	quickConnectInitiate(): Promise<QuickConnectInitiateResponse> {
		return this._post("/auth/quick-connect/initiate", { body: undefined });
	}

	quickConnectCheck(secret: string): Promise<QuickConnectCheckResponse> {
		return this._post("/auth/quick-connect/check", { body: { secret } });
	}

	quickConnectAuthorize(code: string): Promise<{ success: boolean }> {
		return this._post("/auth/quick-connect/authorize", {
			body: { code },
		});
	}

	quickConnectGenerate(): Promise<QuickConnectGenerateResponse> {
		return this._post("/auth/quick-connect/generate", { body: undefined });
	}

	quickConnectRedeem(code: string): Promise<LoginResponse> {
		return this._post("/auth/quick-connect/redeem", {
			body: { code },
		});
	}
}
