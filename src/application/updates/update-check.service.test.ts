import { afterEach, describe, expect, test } from "bun:test";
import { UpdateCheckService } from "./update-check.service";

const SERVER_PAYLOAD = {
	tag_name: "v1.2.3",
	name: "ReelVault Server v1.2.3",
	html_url: "https://github.com/ReelVault/reelvault/releases/tag/v1.2.3",
	published_at: "2026-09-25T00:00:00Z",
	body: "## Changes\n- bug fixes",
	assets: [
		{ name: "ReelVault-Server-1.2.3-linux-x64.tar.gz", browser_download_url: "https://example.com/linux.tar.gz", size: 123 },
		{ name: "SHA256SUMS.txt", browser_download_url: "https://example.com/SHA256SUMS.txt", size: 456 },
		{ name: "garbage", size: "not-a-number" },
	],
};

const WEB_PAYLOAD = {
	tag_name: "v0.2.0",
	name: "ReelVault Web v0.2.0",
	html_url: "https://github.com/ReelVault/website/releases/tag/v0.2.0",
	published_at: "2026-09-25T00:00:00Z",
	body: "## UI changes",
	assets: [{ name: "reelvault-web-0.2.0.zip", browser_download_url: "https://example.com/web.zip", size: 789 }],
};

const SERVER_URL = "https://api.github.com/repos/ReelVault/reelvault/releases/latest";
const WEB_URL = "https://api.github.com/repos/ReelVault/website/releases/latest";

function serviceWith(responses: Map<string, () => { status: number; body: unknown }>): UpdateCheckService {
	return new UpdateCheckService((url) => {
		const responder = responses.get(url);
		if (!responder) return Promise.resolve(new Response("not found", { status: 404 }));

		const response = responder();

		return Promise.resolve(new Response(JSON.stringify(response.body), { status: response.status }));
	});
}

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

describe("UpdateCheckService (two sources)", () => {
	test("maps both release payloads and detects per-component updates", async () => {
		const service = serviceWith(
			new Map<string, () => { status: number; body: unknown }>([
				[SERVER_URL, () => ({ status: 200, body: SERVER_PAYLOAD })],
				[WEB_URL, () => ({ status: 200, body: WEB_PAYLOAD })],
			]),
		);

		await service.checkLatest(true);
		const state = service.getState();

		expect(state.serverLatest?.version).toBe("1.2.3");
		expect(state.webLatest?.version).toBe("0.2.0");
		expect(state.serverUpdateAvailable).toBe(true);
		expect(state.lastCheckedAt).not.toBeNull();
		expect(state.serverLastError).toBeNull();
		expect(state.webLastError).toBeNull();
	});

	test("reads minServerVersion from the web release.json manifest", async () => {
		const webWithManifest = {
			...WEB_PAYLOAD,
			assets: [...WEB_PAYLOAD.assets, { name: "release.json", browser_download_url: "https://example.com/release.json", size: 40 }],
		};
		const service = serviceWith(
			new Map<string, () => { status: number; body: unknown }>([
				[SERVER_URL, () => ({ status: 200, body: SERVER_PAYLOAD })],
				[WEB_URL, () => ({ status: 200, body: webWithManifest })],
				["https://example.com/release.json", () => ({ status: 200, body: { minServerVersion: "1.1.0" } })],
			]),
		);

		await service.checkLatest(true);

		expect(service.getState().webLatest?.minServerVersion).toBe("1.1.0");
	});

	test("a broken manifest degrades to no compatibility constraint", async () => {
		const webWithManifest = {
			...WEB_PAYLOAD,
			assets: [{ name: "release.json", browser_download_url: "https://example.com/release.json", size: 40 }],
		};
		const service = serviceWith(
			new Map<string, () => { status: number; body: unknown }>([
				[SERVER_URL, () => ({ status: 200, body: SERVER_PAYLOAD })],
				[WEB_URL, () => ({ status: 200, body: webWithManifest })],
				["https://example.com/release.json", () => ({ status: 500, body: "boom" })],
			]),
		);

		await service.checkLatest(true);

		expect(service.getState().webLatest?.minServerVersion).toBeNull();
		expect(service.getState().webLastError).toBeNull();
	});

	test("keeps per-source lastError and degrades independently", async () => {
		const service = serviceWith(
			new Map<string, () => { status: number; body: unknown }>([
				[SERVER_URL, () => ({ status: 403, body: { message: "rate limited" } })],
				[WEB_URL, () => ({ status: 200, body: WEB_PAYLOAD })],
			]),
		);

		await service.checkLatest(true);
		const state = service.getState();

		expect(state.serverLatest).toBeNull();
		expect(state.serverLastError).toBe("HTTP 403");
		expect(state.webLatest?.version).toBe("0.2.0");
		expect(state.webLastError).toBeNull();
	});

	test("a garbage tag never counts as an available update", async () => {
		const service = serviceWith(
			new Map<string, () => { status: number; body: unknown }>([
				[SERVER_URL, () => ({ status: 200, body: { tag_name: "not-a-release" } })],
				[WEB_URL, () => ({ status: 404, body: {} })],
			]),
		);

		await service.checkLatest(true);
		const state = service.getState();

		expect(state.serverLatest?.version).toBe("not-a-release");
		expect(state.serverUpdateAvailable).toBe(false);
		expect(state.webLatest).toBeNull();
		expect(state.webLastError).toBe("HTTP 404");
	});

	test("serves the cached releases while the TTL is fresh", async () => {
		let fetchCount = 0;
		const service = new UpdateCheckService(() => {
			fetchCount += 1;

			return Promise.resolve(new Response(JSON.stringify(SERVER_PAYLOAD), { status: 200 }));
		});

		await service.checkLatest(true);
		await service.checkLatest();
		expect(fetchCount).toBe(2); // one fetch per source

		await service.checkLatest(true);
		expect(fetchCount).toBe(4);
	});

	test("a stale status read returns immediately while the refresh runs in the background", async () => {
		let releaseAll = false;
		const pendingResolvers: Array<(response: Response) => void> = [];
		const service = new UpdateCheckService(() => {
			if (releaseAll) return Promise.resolve(new Response(JSON.stringify(SERVER_PAYLOAD), { status: 200 }));

			return new Promise<Response>((resolve) => {
				pendingResolvers.push(resolve);
			});
		});

		const t0 = Date.now();
		await service.checkLatest();
		expect(Date.now() - t0).toBeLessThan(100);
		expect(service.getState().lastCheckedAt).toBeNull();

		releaseAll = true;
		for (const resolve of pendingResolvers.splice(0)) resolve(new Response(JSON.stringify(SERVER_PAYLOAD), { status: 200 }));

		// A forced read drains the shared background refresh and lands fresh state.
		await service.checkLatest(true);
		expect(service.getState().lastCheckedAt).not.toBeNull();
	});
});
