import { SERVER_VERSION } from "@/config/version.constants";
import { DomainError } from "@/utils/domain.errors";

const SEMVER_REGEX = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
/** Full-match `1.2.3` with an optional prerelease/build suffix (no `v` prefix). */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
/** A numeric prerelease identifier (`1` in `rc.1`) — compared numerically, unlike alphanumeric ones. */
const NUMERIC_IDENTIFIER_REGEX = /^\d+$/;

export interface SemverParts {
	major: number;
	minor: number;
	patch: number;
	/** Dot-separated prerelease identifiers (`beta.1`), or null for a release. */
	prerelease: string | null;
}

/** True when `version` is a plain semantic version (`1.2.3`, `1.2.3-beta.1`, `1.2.3+build`). */
export function isValidSemver(version: string): boolean {
	return SEMVER_PATTERN.test(version);
}

/** Parses `1.2.3` / `v1.2.3-beta.1` (+build ignored). Returns null for garbage. */
export function parseSemver(version: string): SemverParts | null {
	const match = SEMVER_REGEX.exec(version.trim());
	if (!match) return null;

	return {
		major: Number.parseInt(match[1] ?? "", 10),
		minor: Number.parseInt(match[2] ?? "", 10),
		patch: Number.parseInt(match[3] ?? "", 10),
		prerelease: match[4] ?? null,
	};
}

/** One prerelease identifier pair: numeric identifiers compare by value and rank below alphanumeric ones. */
function comparePrereleaseIdentifier(a: string, b: string): -1 | 0 | 1 {
	const aNumeric = NUMERIC_IDENTIFIER_REGEX.test(a);
	const bNumeric = NUMERIC_IDENTIFIER_REGEX.test(b);
	if (aNumeric && bNumeric) {
		const diff = Number(a) - Number(b);
		if (diff === 0) return 0;

		return diff < 0 ? -1 : 1;
	}

	// Numeric identifiers always have lower precedence than alphanumeric ones.
	if (aNumeric) return -1;
	if (bNumeric) return 1;
	if (a === b) return 0;

	return a < b ? -1 : 1;
}

/** Semver prerelease precedence: release > prerelease; identifiers compared numerically, then ASCII. */
function comparePrerelease(left: string | null, right: string | null): -1 | 0 | 1 {
	if (left === null && right === null) return 0;
	if (left === null) return 1;
	if (right === null) return -1;

	const leftParts = left.split(".");
	const rightParts = right.split(".");
	for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
		const a = leftParts[index];
		const b = rightParts[index];
		// A shorter identifier list has lower precedence when all shared parts match.
		if (a === undefined) return -1;
		if (b === undefined) return 1;

		const order = comparePrereleaseIdentifier(a, b);
		if (order !== 0) return order;
	}

	return 0;
}

/**
 * True when `candidate` is strictly newer than `current`. Unparseable versions
 * never count as an upgrade — a broken tag must not offer an install. A
 * prerelease never outranks its release (`2.0.0-rc.1 < 2.0.0`).
 */
export function isNewerVersion(candidate: string, current: string): boolean {
	const next = parseSemver(candidate);
	const now = parseSemver(current);
	if (!(next && now)) return false;

	if (next.major !== now.major) return next.major > now.major;
	if (next.minor !== now.minor) return next.minor > now.minor;
	if (next.patch !== now.patch) return next.patch > now.patch;

	return comparePrerelease(next.prerelease, now.prerelease) > 0;
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
