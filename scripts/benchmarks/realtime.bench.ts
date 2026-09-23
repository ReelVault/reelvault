import { fmtMs, main, printTable, suiteArgs, summarizeLatencies, task } from "benchkit";
import { sleep } from "bun";
import { isRecord } from "@/utils/type.utils";

import type { ManagedServer } from "./lib/server";
import { createServerFixture } from "./lib/server-fixture";

/**
 * Realtime WebSocket suite. Zero coverage before this existed. Bun's WebSocket
 * client carries the session cookie via the `headers` option.
 *
 * Phases:
 *  1. ping/pong RTT distribution at N concurrent connections (pacing below the
 *     240 msgs/10s per-connection cap);
 *  2. fan-out latency — one playback session create/delete publishes
 *     playback:session:started/ended to the owning profile, so every socket
 *     connected as that profile receives both events; we measure
 *     trigger→last-socket-receipt.
 */

const PING_PACE_MS = 50;
const EVENT_TIMEOUT_MS = 10_000;

interface WsMessage {
	type: string;
	payload?: unknown;
	occurredAt?: string | undefined;
}

interface WsConnection {
	socket: WebSocket;
	queued: WsMessage[];
	waiters: Array<(message: WsMessage) => void>;
}

/**
 * Bun's client WebSocket accepts per-request headers (the session cookie is
 * the auth for /v1/events/ws), but the ambient DOM declaration shadows that
 * signature — reach the Bun constructor off globalThis with its real shape.
 */
interface BunWebSocketCtor {
	new (url: string | URL, options?: { headers?: Record<string, string> }): WebSocket;
}

function isBunWebSocketCtor(value: unknown): value is BunWebSocketCtor {
	return typeof value === "function";
}

function isWsMessage(value: unknown): value is WsMessage {
	return isRecord(value) && typeof value.type === "string";
}

async function connect(server: ManagedServer, profileId: string): Promise<WsConnection> {
	const queued: WsMessage[] = [];
	const waiters: Array<(message: WsMessage) => void> = [];
	const candidate: unknown = Reflect.get(globalThis, "WebSocket");
	if (!isBunWebSocketCtor(candidate)) throw new Error("global WebSocket constructor unavailable");

	// Bun's constructor takes the session cookie as a request header — the
	// auth for /v1/events/ws.
	const socket = new candidate(`${server.baseUrl.replace("http", "ws")}/v1/events/ws?profileId=${profileId}`, {
		headers: { cookie: server.workerCookies[0] ?? server.cookie },
	});
	socket.addEventListener("message", (event: MessageEvent) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(String(event.data));
		} catch {
			// Not JSON — only {type,...} frames are protocol messages.
			return;
		}

		if (!isWsMessage(parsed)) return;

		const waiter = waiters.shift();
		if (waiter) waiter(parsed);
		else queued.push(parsed);
	});

	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("ws connect timeout")), 5000);
		socket.addEventListener("open", () => {
			clearTimeout(timeout);
			resolve();
		});
	});

	return { socket, queued, waiters };
}

function nextMessage(connection: WsConnection, timeoutMs: number): Promise<WsMessage> {
	const queued = connection.queued.shift();
	if (queued) return Promise.resolve(queued);

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("ws message timeout")), timeoutMs);
		connection.waiters.push((message) => {
			clearTimeout(timeout);
			resolve(message);
		});
	});
}

async function pingPongPhase(server: ManagedServer, profileId: string, connectionCount: number, durationMs: number): Promise<void> {
	const connections: WsConnection[] = [];
	try {
		for (let index = 0; index < connectionCount; index++) {
			connections.push(await connect(server, profileId));
		}

		const rtts: number[] = [];
		const deadline = performance.now() + Math.min(durationMs, 8000);
		await Promise.all(
			connections.map((connection) =>
				(async () => {
					while (performance.now() < deadline) {
						const startedAt = performance.now();
						connection.socket.send("ping");
						const reply = await nextMessage(connection, 5000);
						if (reply.type === "pong") rtts.push(performance.now() - startedAt);

						await sleep(PING_PACE_MS);
					}
				})(),
			),
		);

		const stats = summarizeLatencies(rtts.length > 0 ? rtts : [0]);
		printTable(
			`WS ping/pong RTT, ${connectionCount} connections`,
			["samples", "p50", "p95", "p99", "max"],
			[[String(stats.count), fmtMs(stats.p50Ms), fmtMs(stats.p95Ms), fmtMs(stats.p99Ms), fmtMs(stats.maxMs)]],
		);
	} finally {
		for (const connection of connections) {
			connection.socket.close();
		}
	}
}

async function fanOutPhase(server: ManagedServer, profileId: string, connectionCount: number): Promise<void> {
	const connections: WsConnection[] = [];
	try {
		for (let index = 0; index < connectionCount; index++) {
			connections.push(await connect(server, profileId));
		}

		// Drain startup noise so the event wait below only sees fresh messages.
		await sleep(500);

		// The session must belong to the SAME identity the sockets connected as —
		// playback events fan out per profile, and cross-user profiles 403.
		const headers = {
			"content-type": "application/json",
			cookie: server.workerCookies[0] ?? server.cookie,
			"x-profile-id": profileId,
			"idempotency-key": `benchmark-realtime-fanout-${Date.now()}`,
			"x-forwarded-for": "10.86.0.1",
		};
		const create = await fetch(`${server.baseUrl}/v1/playback-sessions`, {
			method: "POST",
			headers,
			body: JSON.stringify({ mediaFileId: server.sampleMediaId, videoCodecs: ["h264"], audioCodecs: ["aac"] }),
		});
		if (!create.ok) throw new Error(`Fan-out trigger failed: HTTP ${create.status} ${await create.text()}`);

		const created: unknown = await create.json();
		const sessionId =
			typeof created === "object" && created !== null && "sessionId" in created && typeof created.sessionId === "string"
				? created.sessionId
				: undefined;

		const startedAt = performance.now();
		await Promise.all(connections.map((connection) => nextMessage(connection, EVENT_TIMEOUT_MS)));
		const fanOutMs = performance.now() - startedAt;

		if (sessionId) {
			await fetch(`${server.baseUrl}/v1/playback-sessions/${sessionId}`, { method: "DELETE", headers });
		}

		printTable(
			`WS fan-out (playback:session:started → ${connectionCount} sockets)`,
			["trigger→last socket", "sockets"],
			[[fmtMs(fanOutMs), String(connectionCount)]],
		);
	} finally {
		for (const connection of connections) {
			connection.socket.close();
		}
	}
}

export const meta = { description: "Realtime WS (ping/pong RTT at N connections, playback event fan-out)" };

const args = suiteArgs();

if (!args.help) {
	const serverFixture = createServerFixture({
		seedRows: args.rows,
		withSampleMedia: true,
		keepServer: args.keepServer,
	});

	task("realtime: phases", async () => {
		let server: ManagedServer | undefined;
		try {
			server = await serverFixture();
			if (!server.sampleMediaId) {
				console.error("Sample media unavailable — cannot run the realtime benchmark");
				process.exitCode = 1;

				return;
			}

			const profileId = server.profileIdFor(0);
			for (const count of [10, 50, Math.min(100, Math.max(50, Math.max(...args.concurrency)))].filter(
				(value, index, all) => all.indexOf(value) === index,
			)) {
				await pingPongPhase(server, profileId, count, args.durationMs);
				await fanOutPhase(server, profileId, count);
			}
		} finally {
			if (!args.keepServer) {
				await server?.stop();
			}
		}
	});
}

await main(import.meta);
