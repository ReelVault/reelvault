import type {
	LoginResponse,
	Profile,
	QuickConnectCheckResponse,
	QuickConnectGenerateResponse,
	QuickConnectInitiateResponse,
	User,
} from "@reelvault/sdk/common";
import { toPublicUser } from "@/application/auth/auth.service";
import { usersRepository } from "@/database/repositories/users.repository";
import { issueSession } from "@/integrations/better-auth/better-auth.session";
import { MINUTE } from "@/server.constants";
import { BaseService } from "@/utils/base-service";
import { secureRandomInt } from "@/utils/crypto.utils";
import { InternalError, NotFoundError, ValidationError } from "@/utils/errors";
import { rewriteCookieDomain } from "@/utils/http.utils";
import { isExpired } from "@/utils/time.utils";

export interface QuickConnectEntry {
	code: string;
	normalizedCode: string;
	secret: string;
	type: "device_pair" | "voucher";
	status: "pending" | "authenticated";
	/** Set while session creation is in-flight — blocks a second parallel authorize of the same code. */
	authorizing?: boolean | undefined;
	userId?: string | undefined;
	profileId?: string | undefined;
	/** Stored PIN hash of the authorized profile — copied so a redeemed voucher keeps the profile unlocked. */
	profilePin?: string | undefined;
	signedToken?: string | undefined;
	cookies?: string[] | undefined;
	createdAt: Date;
	expiresAt: Date;
}

const EXPIRATION_MS = 15 * MINUTE;
const EXPIRATION_SECONDS = Math.floor(EXPIRATION_MS / 1000);
/** Crockford-ish alphabet without ambiguous characters (I/O/0/1). */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

/** Native shells opt into receiving a JSON bearer token via this header. */
function isNativeClient(request: Request): boolean {
	return request.headers.get("x-client-shell") === "native";
}

export class QuickConnectService extends BaseService {
	private readonly entries = new Map<string, QuickConnectEntry>();
	/** Secondary index: codes are looked up on every device poll — a linear scan over all entries ran per check. */
	private readonly entriesByCode = new Map<string, QuickConnectEntry>();
	private readonly sessionIssuer: typeof issueSession;

	constructor(sessionIssuer: typeof issueSession = issueSession) {
		super("QuickConnectService");
		this.sessionIssuer = sessionIssuer;

		// Clean up expired entries every 2 minutes
		setInterval(() => this.cleanupExpired(), 2 * MINUTE).unref();
	}

	private generateCode(): string {
		// 8 chars from a 32-symbol alphabet ≈ 2^40 combinations — the old 6-digit
		// code (900k) was guessable within its 15-minute window.
		for (let attempt = 0; attempt < 20; attempt++) {
			let raw = "";
			for (let index = 0; index < CODE_LENGTH; index++) raw += CODE_ALPHABET[secureRandomInt(0, CODE_ALPHABET.length - 1)];

			if (!this.findByNormalizedCode(raw)) return `${raw.slice(0, 4)}-${raw.slice(4)}`;
		}

		throw new InternalError("Could not generate a unique quick-connect code", { code: "quick_connect.code_generation_failed" });
	}

	private normalizeCode(raw: string): string {
		return raw.replace(/[^0-9a-zA-Z]/g, "").toUpperCase();
	}

	private findByNormalizedCode(normalized: string): QuickConnectEntry | undefined {
		const entry = this.entriesByCode.get(normalized);
		if (!entry) return undefined;

		if (isExpired(entry.expiresAt)) {
			// Expired but not yet swept — treat (and index) as absent.
			this.entriesByCode.delete(normalized);

			return undefined;
		}

		return entry;
	}

	private removeEntry(secret: string): void {
		const entry = this.entries.get(secret);
		this.entries.delete(secret);
		if (entry) {
			const indexed = this.entriesByCode.get(entry.normalizedCode);
			if (indexed === entry) this.entriesByCode.delete(entry.normalizedCode);
		}
	}

	private cleanupExpired(): void {
		const now = new Date();
		for (const [key, entry] of this.entries) {
			if (entry.expiresAt <= now) this.removeEntry(key);
		}
	}

	private async createSessionAndCookies(
		userId: string,
		profileId?: string | null,
		knownUser?: User,
		profilePin?: string | null,
	): Promise<{ signedToken: string; cookies: string[]; user: User }> {
		const user = knownUser ?? (await usersRepository.findById(userId));
		if (!user) {
			throw new NotFoundError("User not found", { code: "quick_connect.user_not_found" });
		}

		// The active profile reached this point only through the PIN-checked auth
		// middleware, so its stored PIN hash can safely seed the unlock cookie —
		// without it the paired device would receive a token that never matches
		// and silently fall back to "no profile".
		const { signedToken, cookies } = await this.sessionIssuer(userId, profileId, profilePin);

		return { signedToken, cookies, user };
	}

	/**
	 * TV / Device pairing flow: Initiates a pending session and displays a code to the user.
	 */
	initiate(): Promise<QuickConnectInitiateResponse> {
		return this.safeExecute("initiate", () => {
			const { entry, code } = this.createPendingEntry("device_pair");

			return {
				code,
				secret: entry.secret,
				expiresIn: EXPIRATION_SECONDS,
			};
		});
	}

	/**
	 * TV / Device polling: Checks if the pending code has been authorized.
	 */
	check(secret: string, request: Request): Promise<Response> {
		return this.safeExecute("check", async () => {
			const entry = this.entries.get(secret);
			if (!entry || isExpired(entry.expiresAt)) {
				throw new NotFoundError("Quick connect session expired or not found", { code: "quick_connect.session_expired" });
			}

			if (entry.status === "pending") {
				const responseData: QuickConnectCheckResponse = { authenticated: false };

				return Response.json(responseData);
			}

			// Entry is authenticated
			this.removeEntry(secret);

			if (!entry.userId) {
				throw new NotFoundError("User not associated with session", { code: "quick_connect.session_user_missing" });
			}

			const user = await usersRepository.findById(entry.userId);
			if (!user) {
				throw new NotFoundError("User not found", { code: "quick_connect.user_not_found" });
			}

			const responseData: QuickConnectCheckResponse = {
				authenticated: true,
				user: toPublicUser(user),
				redirect: false,
				// Browser clients authenticate via the Set-Cookie session and must not
				// receive a JS-readable bearer token; native shells still need it.
				...(entry.signedToken && isNativeClient(request) ? { token: entry.signedToken } : {}),
			};

			return this.respondWithSessionCookies(responseData, entry.cookies, request);
		});
	}

	/**
	 * Logged-in user authorizes a TV / Device pairing code.
	 */
	authorize(code: string, user: User, profile?: Profile | null): Promise<{ success: boolean }> {
		return this.safeExecute("authorize", async () => {
			const normalized = this.normalizeCode(code);
			const entry = this.findByNormalizedCode(normalized);

			if (entry?.type !== "device_pair") {
				throw new NotFoundError("Invalid or expired quick connect code", { code: "quick_connect.code_invalid" });
			}

			// Synchronous claim: two concurrent authorizes of the same code must not
			// create two sessions (the pending check alone races across awaits).
			if (entry.status !== "pending" || entry.authorizing) {
				throw new ValidationError("Quick connect code has already been used", { code: "quick_connect.code_already_used" });
			}

			entry.authorizing = true;

			try {
				// The caller already holds the user row — skip the second read.
				const { signedToken, cookies } = await this.createSessionAndCookies(user.id, profile?.id, user, profile?.pin);

				entry.status = "authenticated";
				entry.userId = user.id;
				entry.profileId = profile?.id;
				entry.signedToken = signedToken;
				entry.cookies = cookies;
			} catch (error) {
				entry.authorizing = false;
				throw error;
			}

			return { success: true };
		});
	}

	/**
	 * Voucher flow: Logged-in user generates a quick login code directly from their account/profile.
	 */
	generate(user: User, profile?: Profile | null): Promise<QuickConnectGenerateResponse> {
		return this.safeExecute("generate", () => {
			const { code } = this.createPendingEntry("voucher", {
				userId: user.id,
				profileId: profile?.id,
				profilePin: profile?.pin ?? undefined,
			});

			return {
				code,
				expiresIn: EXPIRATION_SECONDS,
			};
		});
	}

	/** Registers a fresh pending entry — shared by the pairing and voucher flows. */
	private createPendingEntry(
		type: QuickConnectEntry["type"],
		owner?: { userId: string; profileId?: string | undefined; profilePin?: string | undefined },
	): { entry: QuickConnectEntry; code: string } {
		this.cleanupExpired();
		const code = this.generateCode();
		const secret = crypto.randomUUID();
		const now = new Date();

		const entry: QuickConnectEntry = {
			code,
			normalizedCode: this.normalizeCode(code),
			secret,
			type,
			status: "pending",
			...(owner?.userId ? { userId: owner.userId } : {}),
			...(owner?.profileId ? { profileId: owner.profileId } : {}),
			...(owner?.profilePin ? { profilePin: owner.profilePin } : {}),
			createdAt: now,
			expiresAt: new Date(now.getTime() + EXPIRATION_MS),
		};

		this.entries.set(secret, entry);
		this.entriesByCode.set(entry.normalizedCode, entry);

		return { entry, code };
	}

	/**
	 * Device redeems a voucher code generated by an account/profile.
	 */
	redeem(code: string, request: Request): Promise<Response> {
		return this.safeExecute("redeem", async () => {
			const normalized = this.normalizeCode(code);
			const entry = this.findByNormalizedCode(normalized);

			if (entry?.type !== "voucher" || !entry.userId) {
				throw new NotFoundError("Invalid or expired login code", { code: "quick_connect.voucher_invalid" });
			}

			if (entry.status !== "pending") {
				throw new ValidationError("Login code has already been used", { code: "quick_connect.voucher_already_used" });
			}

			// Invalidate voucher immediately so it's one-time use
			this.removeEntry(entry.secret);

			const { signedToken, cookies, user } = await this.createSessionAndCookies(entry.userId, entry.profileId, undefined, entry.profilePin);

			const responseData: LoginResponse = {
				token: signedToken,
				user: toPublicUser(user),
				redirect: false,
			};

			return this.respondWithSessionCookies(responseData, cookies, request);
		});
	}

	/** JSON response carrying the session cookies, with the request's cookie-domain rewrite applied. */
	private respondWithSessionCookies(responseData: unknown, cookies: readonly string[] | undefined, request: Request): Response {
		const headers = new Headers({ "Content-Type": "application/json" });
		for (const cookie of cookies ?? []) {
			headers.append("Set-Cookie", cookie);
		}

		return rewriteCookieDomain(new Response(JSON.stringify(responseData), { status: 200, headers }), request.headers.get("origin"));
	}
}

export const quickConnectService = new QuickConnectService();
