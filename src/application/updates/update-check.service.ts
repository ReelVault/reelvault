import type { AdminUpdateRelease } from "@reelvault/sdk/common";
import { BaseService } from "@/utils/base-service";
import { detach } from "@/utils/promise.utils";
import { isNewerVersion } from "@/utils/semver.utils";
import { isRecord } from "@/utils/type.utils";
import { guardedFetch } from "@/utils/url-guard.utils";
import { SERVER_VERSION } from "@/version";
import { resolveWebVersion } from "@/web/web-dist";

const SERVER_RELEASES_URL = "https://api.github.com/repos/ReelVault/reelvault/releases/latest";
const WEB_RELEASES_URL = "https://api.github.com/repos/ReelVault/website/releases/latest";
/** Unauthenticated GitHub allows 60 requests/h per IP — a TTL keeps us far below. */
const CHECK_TTL_MS = 6 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const TAG_V_PREFIX_REGEX = /^v/;
const SEMVER_REGEX = /^\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$/;

export interface UpdateCheckState {
	serverLatest: AdminUpdateRelease | null;
	webLatest: AdminUpdateRelease | null;
	serverUpdateAvailable: boolean;
	webRequiresServerUpdate: boolean;
	webUpdateAvailable: boolean;
	lastCheckedAt: string | null;
	serverLastError: string | null;
	webLastError: string | null;
}

type ReleaseFetcher = (url: string) => Promise<Response>;

function toRelease(payload: unknown): AdminUpdateRelease | null {
	if (!isRecord(payload)) return null;

	const tagName = payload.tag_name;
	const version = typeof tagName === "string" ? tagName.replace(TAG_V_PREFIX_REGEX, "") : "";
	if (!version) return null;

	const rawAssets = payload.assets;
	const assets = Array.isArray(rawAssets) ? rawAssets : [];
	const mappedAssets = assets.flatMap((asset) => {
		if (!isRecord(asset)) return [];
		if (typeof asset.name !== "string" || typeof asset.browser_download_url !== "string") return [];

		return [{ name: asset.name, url: asset.browser_download_url, size: typeof asset.size === "number" ? asset.size : 0 }];
	});

	const releaseName = payload.name;
	const htmlUrl = payload.html_url;
	const publishedAt = payload.published_at;
	const body = payload.body;

	return {
		version,
		name: typeof releaseName === "string" && releaseName.length > 0 ? releaseName : `ReelVault ${version}`,
		url: typeof htmlUrl === "string" ? htmlUrl : "",
		publishedAt: typeof publishedAt === "string" ? publishedAt : null,
		notes: typeof body === "string" && body.length > 0 ? body : null,
		minServerVersion: null,
		assets: mappedAssets,
	};
}

/** Optional per-release compatibility manifest shipped with web releases. */
async function toWebRelease(payload: unknown, fetcher: ReleaseFetcher): Promise<AdminUpdateRelease | null> {
	const release = toRelease(payload);
	if (!release) return null;

	const manifestAsset = release.assets.find((asset) => asset.name === "release.json");
	if (!manifestAsset) return release;

	try {
		const response = await fetcher(manifestAsset.url);
		if (!response.ok) throw new Error(`Compatibility manifest download failed with HTTP ${response.status}`);

		const manifest: unknown = await response.json();
		if (isRecord(manifest) && typeof manifest.minServerVersion === "string") {
			const min = manifest.minServerVersion.replace(TAG_V_PREFIX_REGEX, "");
			if (!SEMVER_REGEX.test(min)) throw new Error(`Compatibility manifest has an invalid minServerVersion: ${manifest.minServerVersion}`);

			release.minServerVersion = min;
		}
	} catch {
		// A missing or broken manifest degrades to "no compatibility constraint".
	}

	return release;
}

export class UpdateCheckService extends BaseService {
	private readonly fetcher: ReleaseFetcher;
	private cachedServer: AdminUpdateRelease | null = null;
	private cachedWeb: AdminUpdateRelease | null = null;
	private cachedAt = 0;
	private serverLastError: string | null = null;
	private webLastError: string | null = null;
	private inFlight: Promise<void> | null = null;

	constructor(
		fetcher: ReleaseFetcher = (url) =>
			guardedFetch(url, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
	) {
		super("UpdateCheckService");
		this.fetcher = fetcher;
	}

	/**
	 * Fetches both component releases when the cache is stale. Failures are
	 * kept per source and logged — an unreachable GitHub must never break boot
	 * or a status read (expected anomaly → warn + degrade).
	 */
	async checkLatest(force = false): Promise<void> {
		if (!force && this.cachedAt > 0 && Date.now() - this.cachedAt < CHECK_TTL_MS) return;

		// Concurrent status reads share one refresh instead of hammering GitHub.
		this.inFlight ??= this.fetchLatest();
		try {
			await this.inFlight;
		} finally {
			this.inFlight = null;
		}
	}

	getState(): UpdateCheckState {
		const webVersion = resolveWebVersion();
		const minServer = this.cachedWeb?.minServerVersion ?? null;

		return {
			serverLatest: this.cachedServer,
			webLatest: this.cachedWeb,
			serverUpdateAvailable: this.cachedServer ? isNewerVersion(this.cachedServer.version, SERVER_VERSION) : false,
			webUpdateAvailable: this.cachedWeb && webVersion ? isNewerVersion(this.cachedWeb.version, webVersion) : false,
			webRequiresServerUpdate: minServer !== null && isNewerVersion(minServer, SERVER_VERSION),
			lastCheckedAt: this.cachedAt > 0 ? new Date(this.cachedAt).toISOString() : null,
			serverLastError: this.serverLastError,
			webLastError: this.webLastError,
		};
	}

	private async fetchLatest(): Promise<void> {
		const [serverResult, webResult] = await Promise.allSettled([this.fetchServerRelease(), this.fetchWebRelease()]);

		if (serverResult.status === "fulfilled") {
			this.cachedServer = serverResult.value;
			this.serverLastError = null;
		} else {
			this.serverLastError = reasonOf(serverResult.reason);
			this.logger.warn("Server release check failed — keeping previous state", { reason: this.serverLastError });
		}

		if (webResult.status === "fulfilled") {
			this.cachedWeb = webResult.value;
			this.webLastError = null;
		} else {
			this.webLastError = reasonOf(webResult.reason);
			this.logger.warn("Web release check failed — keeping previous state", { reason: this.webLastError });
		}

		this.cachedAt = Date.now();
		this.logger.info("Update check completed", {
			serverVersion: SERVER_VERSION,
			serverLatest: this.cachedServer?.version ?? null,
			webVersion: resolveWebVersion(),
			webLatest: this.cachedWeb?.version ?? null,
		});
	}

	private async fetchServerRelease(): Promise<AdminUpdateRelease | null> {
		const response = await this.fetcher(SERVER_RELEASES_URL);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);

		const payload: unknown = await response.json();
		const release = toRelease(payload);
		if (!release) throw new Error("Release payload was missing a usable tag name");

		return release;
	}

	private async fetchWebRelease(): Promise<AdminUpdateRelease | null> {
		const response = await this.fetcher(WEB_RELEASES_URL);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);

		const payload: unknown = await response.json();
		const release = await toWebRelease(payload, this.fetcher);
		if (!release) throw new Error("Release payload was missing a usable tag name");

		return release;
	}
}

function reasonOf(reason: unknown): string {
	return reason instanceof Error ? reason.message : "unknown error";
}

export const updateCheckService = new UpdateCheckService();

/** Kick a first check in the background without ever blocking or failing boot. */
export function scheduleStartupUpdateCheck(): void {
	detach(updateCheckService.checkLatest());
}
