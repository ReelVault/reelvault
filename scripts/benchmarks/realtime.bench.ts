import { fmtMs, main, printTable, suiteArgs, summarizeLatencies, task } from "benchkit";
import { sleep } from "bun";
import { isRecord } from "@/utils/type.utils";

import { createPlaybackSession, deletePlaybackSession } from "./lib/playback";
import type { ManagedServer } from "./lib/server";
import { suiteServerFixture } from "./lib/server-fixture";

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

async function connect(server: ManagedServer, profileId: string, workerIndex = 0): Promise<WsConnection> {
	const queued: WsMessage[] = [];
	const waiters: Array<(message: WsMessage) => void> = [];
	const candidate: unknown = Reflect.get(globalThis, "WebSocket");
	if (!isBunWebSocketCtor(candidate)) throw new Error("global WebSocket constructor unavailable");

	// Bun's constructor takes the session cookie as a request header — the
	// auth for /v1/events/ws.
	const socket = new candidate(`${server.baseUrl.replace("http", "ws")}/v1/events/ws?profileId=${profileId}`, {
		headers: { cookie: server.workerCookies[workerIndex] ?? server.workerCookies[0] ?? server.cookie },
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
		const sessionId = await createPlaybackSession(server, headers);

		const startedAt = performance.now();
		await Promise.all(connections.map((connection) => nextMessage(connection, EVENT_TIMEOUT_MS)));
		const fanOutMs = performance.now() - startedAt;

		await deletePlaybackSession(server, sessionId, headers);

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

/**
 * Fan-out across MANY profiles: one socket per identity, a session created per
 * profile, trigger→receipt measured per event. The single-profile fan-out
 * above stresses one broadcast list; this stresses the per-profile routing
 * path the downloads/streams dashboards actually ride on.
 */
async function multiProfileFanOutPhase(server: ManagedServer, profileCount: number): Promise<void> {
	const connections: WsConnection[] = [];
	try {
		// The session-creation guard enforces a 500ms per-profile cooldown, so each
		// identity creates AT MOST ONE session in this phase.
		const identities = Math.min(profileCount, server.workerCookies.length);
		for (let index = 0; index < identities; index++) {
			connections.push(await connect(server, server.profileIdFor(index), index));
		}

		await sleep(550);

		const latencies: number[] = [];
		for (let index = 0; index < identities; index++) {
			const profileId = server.profileIdFor(index);
			const headers = {
				"content-type": "application/json",
				cookie: server.workerCookies[index] ?? server.cookie,
				"x-profile-id": profileId,
				"idempotency-key": `benchmark-realtime-multi-${index}-${Date.now()}`,
				"x-forwarded-for": "10.86.1.1",
			};
			const sessionId = await createPlaybackSession(server, headers);

			const startedAt = performance.now();
			const connection = connections[index];
			if (connection) await nextMessage(connection, EVENT_TIMEOUT_MS);
			latencies.push(performance.now() - startedAt);

			await deletePlaybackSession(server, sessionId, headers);
			await sleep(550);
		}

		const stats = summarizeLatencies(latencies.length > 0 ? latencies : [0]);
		printTable(
			`WS multi-profile fan-out (${identities} profiles, trigger→receipt per event)`,
			["samples", "p50", "p95", "max"],
			[[String(stats.count), fmtMs(stats.p50Ms), fmtMs(stats.p95Ms), fmtMs(stats.maxMs)]],
		);
	} finally {
		for (const connection of connections) {
			connection.socket.close();
		}
	}
}

/** Event burst: one profile, K sockets, R rapid session create/delete cycles. */
async function eventBurstPhase(server: ManagedServer, profileId: string, socketCount: number, cycles: number): Promise<void> {
	const connections: WsConnection[] = [];
	try {
		for (let index = 0; index < socketCount; index++) {
			connections.push(await connect(server, profileId));
		}

		await sleep(500);

		const headers = {
			"content-type": "application/json",
			cookie: server.workerCookies[0] ?? server.cookie,
			"x-profile-id": profileId,
			"idempotency-key": "benchmark-realtime-burst",
			"x-forwarded-for": "10.86.2.1",
		};

		const startedAt = performance.now();
		let delivered = 0;
		for (let cycle = 0; cycle < cycles; cycle++) {
			headers["idempotency-key"] = `benchmark-realtime-burst-${cycle}-${Date.now()}`;
			const sessionId = await createPlaybackSession(server, headers);

			await Promise.all(connections.map((connection) => nextMessage(connection, EVENT_TIMEOUT_MS)));
			delivered += connections.length;

			await deletePlaybackSession(server, sessionId, headers);
			// Session-creation guard: 500ms per-profile cooldown between cycles.
			await sleep(550);
		}

		const wallMs = performance.now() - startedAt;
		printTable(
			`WS event burst (${cycles} cycles → ${socketCount} sockets)`,
			["events delivered", "events/s", "wall"],
			[[String(delivered), (delivered / (wallMs / 1000)).toFixed(0), fmtMs(wallMs)]],
		);
	} finally {
		for (const connection of connections) {
			connection.socket.close();
		}
	}
}

export const meta = { description: "Realtime WS (ping/pong RTT, playback fan-out, multi-profile fan-out, event burst)" };

const args = suiteArgs();

if (!args.help) {
	const serverFixture = suiteServerFixture(args, { withSampleMedia: true });

	task("realtime: phases", async () => {
		const server = await serverFixture();
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

		await multiProfileFanOutPhase(server, Math.min(30, Math.max(10, server.workerCookies.length * 3)));
		await eventBurstPhase(server, profileId, 10, 20);
	});
}

await main(import.meta);
