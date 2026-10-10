import { isAPIError } from "better-auth/api";
import {
	ConflictError,
	type DomainError,
	ForbiddenError,
	InternalError,
	NotFoundError,
	UnauthorizedError,
	ValidationError,
} from "@/utils/errors";
import { isRecord } from "@/utils/type.utils";

/** better-auth error `code`s mapped onto the API's stable error codes. */
const CONFLICT_CODES = new Set(["USER_ALREADY_EXISTS", "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"]);
const WEAK_PASSWORD_CODES = new Set(["PASSWORD_TOO_SHORT", "PASSWORD_TOO_LONG"]);

const DEFAULT_INVALID_PASSWORD_CODE = "auth.invalid_credentials";

/**
 * Translates a better-auth failure (HTTP status + its machine `code`) into a DomainError.
 * better-auth's `message` is English prose; the API only ever carries stable codes, so the
 * prose is never forwarded.
 *
 * `invalidPasswordCode` names the code for a rejected password: wrong login credentials by
 * default, or a flow-specific code (e.g. a wrong *current* password, which is a 400 so
 * that clients do not mistake it for an expired session).
 */
function mapFailure(status: number, code: string, invalidPasswordCode: string): DomainError {
	if (CONFLICT_CODES.has(code)) return new ConflictError("Email is already registered", { code: "auth.email_registered" });

	if (WEAK_PASSWORD_CODES.has(code)) return new ValidationError("Password length is not allowed", { code: "auth.weak_password" });

	if (code === "INVALID_EMAIL") return new ValidationError("Email is not valid", { code: "auth.invalid_email" });

	if (code === "BANNED_USER") return new ForbiddenError("This account is blocked", { code: "auth.user_banned" });

	if (code === "INVALID_PASSWORD" || code === "INVALID_EMAIL_OR_PASSWORD") {
		return invalidPasswordCode === DEFAULT_INVALID_PASSWORD_CODE
			? new UnauthorizedError("Invalid email or password", { code: invalidPasswordCode })
			: new ValidationError("Current password is incorrect", { code: invalidPasswordCode });
	}

	if (status === 401) return new UnauthorizedError("Authentication failed", { code: DEFAULT_INVALID_PASSWORD_CODE });

	if (status === 403) return new ForbiddenError("Not allowed", { code: "auth.not_allowed" });

	if (status === 404) return new NotFoundError("Not found", { code: "auth.not_found" });

	if (status >= 400 && status < 500) return new ValidationError("Authentication request rejected", { code: "auth.request_rejected" });

	return new InternalError("Authentication provider failed", { code: "auth.provider_failed" });
}

/** Maps a non-OK better-auth `Response` (`{ code, message }` body) to a DomainError. */
export async function toAuthFailure(response: Response, invalidPasswordCode: string = DEFAULT_INVALID_PASSWORD_CODE): Promise<DomainError> {
	const body: unknown = await response
		.clone()
		.json()
		.catch(() => null);
	const code = isRecord(body) && typeof body.code === "string" ? body.code : "";

	return mapFailure(response.status, code, invalidPasswordCode);
}

/** Runs a better-auth server call and rethrows its `APIError` as a DomainError (other errors pass through). */
export async function withAuthFailures<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (!isAPIError(error)) throw error;

		const code = isRecord(error.body) && typeof error.body.code === "string" ? error.body.code : "";
		throw mapFailure(error.statusCode, code, DEFAULT_INVALID_PASSWORD_CODE);
	}
}
