import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fmtMs, main, printHttpResults, printTable, runScenarioMatrix, suiteArgs, task } from "benchkit";
import { adminLogsService } from "@/application/admin/admin-logs.service";
import { serverConfig } from "@/server.config";
import { isRecord } from "@/utils/type.utils";
import { subnetIp, workerCookie } from "./lib/identity";
import { preloadUnreadNotificationIds } from "./lib/notifications";
import { jsonRequest } from "./lib/request";
import { toScenarioEntries } from "./lib/scenarios";
import type { ManagedServer } from "./lib/server";
import { suiteServerFixture } from "./lib/server-fixture";

/**
 * Admin + account write endpoints — the mutation surfaces no other suite
 * covers (scan enqueue, bulk notification mark-read, profile/preferences
 * mutations, settings round-trip). One identity per worker, like write.ts.
 * The trickplay generate-all phase runs LAST and one-shot: a single call
 * enqueues a job per media file missing previews, which would flood every
 * other measurement with worker churn if it ran mid-suite.
 */

interface AdminWriteContext {
	baseUrl: string;
	cookieFor: (workerIndex: number) => string;
	profileIdFor: (workerIndex: number) => string;
	adminCookie: string;
	adminProfileId: string;
	libraryId: string;
	/** Preloaded unread notification ids per worker identity. */
	notificationIds: string[][];
	/** First settings key + current value resolved at setup (round-trip body). */
	settingsPatchBody: Record<string, unknown> | undefined;
}

type WriteRequestBuilder = (context: AdminWriteContext, workerIndex: number, requestIndex: number) => Request;

function workerHeaders(context: AdminWriteContext, workerIndex: number): Record<string, string> {
	return {
		cookie: context.cookieFor(workerIndex),
		"x-profile-id": context.profileIdFor(workerIndex),
		"x-forwarded-for": subnetIp(83, workerIndex),
	};
}

function adminRequest(context: AdminWriteContext, method: "POST" | "PATCH", path: string, body?: unknown): Request {
	const headers: Record<string, string> = {
		cookie: context.adminCookie,
		"x-profile-id": context.adminProfileId,
		"x-forwarded-for": "10.83.255.1",
	};

	return jsonRequest(`${context.baseUrl}${path}`, method, headers, body);
}

const scanEnqueue: WriteRequestBuilder = (context) =>
	// Scans enqueue into worker_jobs; a concurrent duplicate settles as 409,
	// which is still a full enqueue-path measurement — counted as status < 500.
	adminRequest(context, "POST", `/v1/libraries/${context.libraryId}/scan`);

const notificationsMarkRead: WriteRequestBuilder = (context, workerIndex) => {
	const ids = context.notificationIds[workerIndex] ?? [];
	const body = ids.length > 0 ? { ids, read: true } : { all: true, read: true };

	return jsonRequest(`${context.baseUrl}/v1/notifications/`, "PATCH", workerHeaders(context, workerIndex), body);
};

const preferencesLanguageToggle: WriteRequestBuilder = (context, workerIndex, requestIndex) =>
	// Alternating non-default values keep the sparse-override row alive —
	// every request is a real upsert, never a prune-delete no-op.
	jsonRequest(
		`${context.baseUrl}/v1/profiles/${context.profileIdFor(workerIndex)}/preferences`,
		"PATCH",
		workerHeaders(context, workerIndex),
		{
			language: requestIndex % 2 === 0 ? "pl" : "en",
		},
	);

const profileCreateDelete: WriteRequestBuilder = (context, workerIndex, requestIndex) => {
	// Encode both pair halves in one request: POST carries the name, the DELETE
	// path is derived from the created id by the work function.
	const name = `Bench Pair ${workerIndex}-${requestIndex >> 1}`;

	return jsonRequest(`${context.baseUrl}/v1/profiles`, "POST", workerHeaders(context, workerIndex), { name });
};

const settingsRoundTrip: WriteRequestBuilder = (context) =>
	adminRequest(context, "PATCH", "/v1/admin/settings", context.settingsPatchBody ?? {});

interface WriteScenarioDefinition {
	name: string;
	builder: WriteRequestBuilder;
	/** The work function drives multi-request pairs; single-request by default. */
	pair?: boolean;
}

const SCENARIOS: readonly WriteScenarioDefinition[] = [
	{ name: "POST /v1/libraries/:id/scan (enqueue)", builder: scanEnqueue },
	{ name: "PATCH /v1/notifications/ (bulk mark-read)", builder: notificationsMarkRead },
	{ name: "PATCH /v1/profiles/:id/preferences (language toggle)", builder: preferencesLanguageToggle },
	{ name: "POST+DELETE /v1/profiles (create/delete pair)", builder: profileCreateDelete, pair: true },
	{ name: "PATCH /v1/admin/settings (round-trip)", builder: settingsRoundTrip },
];

/** Create→delete pair: the latency of the whole cycle is one sample. */
function pairWork(scenario: WriteScenarioDefinition, context: AdminWriteContext) {
	return async (workerIndex: number, requestIndex: number): Promise<{ ok: boolean }> => {
		try {
			const response = await fetch(scenario.builder(context, workerIndex, requestIndex));
			const ok = response.status < 500;
			const body: unknown = await response.json();
			let createdId: string | undefined;
			if (isRecord(body) && typeof body.id === "string") createdId = body.id;
			if (!createdId && isRecord(body) && isRecord(body.data) && typeof body.data.id === "string") createdId = body.data.id;
			if (!createdId) return { ok: false };

			const deleteResponse = await fetch(`${context.baseUrl}/v1/profiles/${createdId}`, {
				method: "DELETE",
				headers: workerHeaders(context, workerIndex),
			});
			await deleteResponse.arrayBuffer();

			return { ok: ok && deleteResponse.status < 500 };
		} catch {
			return { ok: false };
		}
	};
}

/** Resolves the first settings key and its current value for a write-that-changes-nothing PATCH. */
async function resolveSettingsPatchBody(server: ManagedServer): Promise<Record<string, unknown> | undefined> {
	const get = await fetch(`${server.baseUrl}/v1/admin/settings`, {
		headers: { cookie: server.cookie, "x-forwarded-for": "10.83.255.1" },
	});
	if (!get.ok) return undefined;

	const grouped: unknown = await get.json();
	if (!isRecord(grouped)) return undefined;

	for (const group of Object.values(grouped)) {
		if (!Array.isArray(group)) continue;
		for (const item of group) {
			if (!isRecord(item) || typeof item.key !== "string") continue;

			return { [item.key]: item.value };
		}
	}

	return undefined;
}

/** One-shot: a single generate-all enqueues one worker job per file missing previews. */
async function trickplayGenerateAllPhase(context: AdminWriteContext): Promise<void> {
	const statsResponse = await fetch(`${context.baseUrl}/v1/admin/trickplay/stats`, {
		headers: { cookie: context.adminCookie, "x-profile-id": context.adminProfileId, "x-forwarded-for": "10.83.255.2" },
	});
	let missing = -1;
	if (statsResponse.ok) {
		const stats: unknown = await statsResponse.json();
		if (isRecord(stats)) {
			const value = stats.missing ?? stats.withoutTrickplay ?? stats.total;
			if (typeof value === "number") missing = value;
		}
	}

	const startedAt = performance.now();
	const response = await fetch(`${context.baseUrl}/v1/admin/trickplay/generate-all`, {
		method: "POST",
		headers: { cookie: context.adminCookie, "x-profile-id": context.adminProfileId, "x-forwarded-for": "10.83.255.2" },
	});
	const body: unknown = await response.json().catch(() => null);
	const wallMs = performance.now() - startedAt;
	const enqueued = isRecord(body) && typeof body.enqueued === "number" ? body.enqueued : -1;

	printTable(
		"POST /v1/admin/trickplay/generate-all (one-shot wall clock)",
		["missing files", "enqueued", "wall", "status"],
		[[String(missing), String(enqueued), fmtMs(wallMs), String(response.status)]],
	);
}

export const meta = { description: "Admin/account write endpoints (scan, bulk mark-read, profiles, settings, trickplay generate-all)" };

const args = suiteArgs();

async function measureLogPoll(): Promise<number> {
	const startedAt = performance.now();
	await adminLogsService.getLogs({ fileId: "reelvault.log", limit: 100 });

	return performance.now() - startedAt;
}

if (!args.help) {
	const serverFixture = suiteServerFixture(args);

	// The log viewer polls while the logger appends. Characterise a poll that
	// arrives 3 s after the previous one: with a 2 s tail-cache TTL it rebuilt
	// from the 2 MiB window; the incremental append path must take over instead.
	task("write-admin: log tail cache poll", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-log-tail-"));
		try {
			const filePath = join(directory, "reelvault.log");
			const line = JSON.stringify({ level: 30, time: Date.now(), msg: "benchmark log line", module: "Bench" });
			const lineCount = 20_000;
			await writeFile(filePath, `${Array.from({ length: lineCount }, () => line).join("\n")}\n`);

			// Point the service at the temp logs root for this task.
			const originalLogs = serverConfig.paths.logs;
			serverConfig.paths.logs = directory;
			try {
				const coldMs = await measureLogPoll();
				const warmMs = await measureLogPoll();

				await new Promise((resolve) => {
					setTimeout(resolve, 3_000);
				});
				await appendFile(filePath, `${line}\n`);
				const afterIdleMs = await measureLogPoll();

				printTable(
					"Admin log tail (20k-line JSONL, page of 100)",
					["cold rebuild", "warm poll", "poll after 3 s idle"],
					[[fmtMs(coldMs), fmtMs(warmMs), fmtMs(afterIdleMs)]],
				);
			} finally {
				serverConfig.paths.logs = originalLogs;
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}

		return { ok: true };
	});

	task("write-admin: endpoints", async () => {
		const server = await serverFixture();
		const workerCount = server.workerCookies.length;
		const notificationIds = await Promise.all(
			Array.from({ length: workerCount }, (_, workerIndex) => preloadUnreadNotificationIds(server, workerIndex, "10.83.0.1")),
		);
		const settingsPatchBody = await resolveSettingsPatchBody(server);
		console.log(
			`[write-admin] server ready, ${workerCount} identities, ${notificationIds.flat().length} unread notifications, settings patch ${settingsPatchBody ? Object.keys(settingsPatchBody).join(",") : "unavailable"}`,
		);

		const context: AdminWriteContext = {
			baseUrl: server.baseUrl,
			cookieFor: (workerIndex) => workerCookie(server, workerIndex),
			profileIdFor: (workerIndex) => server.profileIdFor(workerIndex),
			adminCookie: server.cookie,
			adminProfileId: server.adminProfileId,
			libraryId: server.benchmarkLibraryId,
			notificationIds,
			settingsPatchBody,
		};

		const scenarios = SCENARIOS.filter((scenario) => scenario.name !== "PATCH /v1/admin/settings (round-trip)" || settingsPatchBody);
		const results = await runScenarioMatrix({
			suite: "write-admin",
			unit: "writes/s",
			scenarios: toScenarioEntries(scenarios, context, {
				accept: (response) => response.status < 500,
				workFor: (scenario) => (scenario.pair ? pairWork(scenario, context) : undefined),
			}),
			concurrency: args.concurrency,
			warmupMs: args.warmupMs,
			durationMs: args.durationMs,
		});

		printHttpResults(results);

		// LAST: generate-all floods the worker queue with per-file jobs.
		await trickplayGenerateAllPhase(context);
	});
}

await main(import.meta);
