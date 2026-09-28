const SEMVER_REGEX = /^v?(\d+)\.(\d+)\.(\d+)/;

export interface SemverParts {
	major: number;
	minor: number;
	patch: number;
}

/** Parses `1.2.3` / `v1.2.3` (prerelease suffixes ignored). Returns null for garbage. */
export function parseSemver(version: string): SemverParts | null {
	const match = SEMVER_REGEX.exec(version.trim());
	if (!match) return null;

	return {
		major: Number.parseInt(match[1] ?? "", 10),
		minor: Number.parseInt(match[2] ?? "", 10),
		patch: Number.parseInt(match[3] ?? "", 10),
	};
}

/**
 * True when `candidate` is strictly newer than `current`. Unparseable versions
 * never count as an upgrade — a broken tag must not offer an install.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
	const next = parseSemver(candidate);
	const now = parseSemver(current);
	if (!(next && now)) return false;

	if (next.major !== now.major) return next.major > now.major;
	if (next.minor !== now.minor) return next.minor > now.minor;

	return next.patch > now.patch;
}
