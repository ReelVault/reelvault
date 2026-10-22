import { SERVER_VERSION } from "@/config/version.constants";
import { DomainError } from "@/utils/domain.errors";

/** Full-match `1.2.3` with an optional prerelease/build suffix (no `v` prefix). */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;

/** True when `version` is a plain semantic version (`1.2.3`, `1.2.3-beta.1`, `1.2.3+build`). */
export function isValidSemver(version: string): boolean {
	return SEMVER_PATTERN.test(version);
}

/** Strips a leading `v` and surrounding whitespace; null when what remains is not a plain semantic version. */
function normalizeVersion(version: string): string | null {
	const trimmed = version.trim();
	const withoutPrefix = trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;

	return SEMVER_PATTERN.test(withoutPrefix) ? withoutPrefix : null;
}

/**
 * True when `candidate` is strictly newer than `current`. Unparseable versions
 * never count as an upgrade — a broken tag must not offer an install. A
 * prerelease never outranks its release (`2.0.0-rc.1 < 2.0.0`).
 */
export function isNewerVersion(candidate: string, current: string): boolean {
	const next = normalizeVersion(candidate);
	const now = normalizeVersion(current);
	if (!(next && now)) return false;

	try {
		return Bun.semver.order(next, now) > 0;
	} catch {
		return false;
	}
}

/** True when the running server is older than the declared `minServerVersion`. */
export function requiresNewerServer(minServerVersion: string | null | undefined): minServerVersion is string {
	return typeof minServerVersion === "string" && isNewerVersion(minServerVersion, SERVER_VERSION);
}

/** The one sentence every server-version gate uses, without the subject prefix. */
export function serverVersionRequirementMessage(minServerVersion: string): string {
	return `requires server ${minServerVersion} or newer (running ${SERVER_VERSION})`;
}

/** The validation error for a subject that needs a newer server, or undefined when the server is new enough. */
export function minServerVersionError(minServerVersion: string | null | undefined, subject: string, code: string): DomainError | undefined {
	if (!requiresNewerServer(minServerVersion)) return undefined;

	return new DomainError("validation", `${subject} ${serverVersionRequirementMessage(minServerVersion)} — update the server first`, {
		code,
	});
}
