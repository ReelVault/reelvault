import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { databaseFactory } from "@/database/database";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { mediaRepository } from "./media-files.repository";

// Works against both an unmigrated ambient test DB (stub shape) and a migrated
// one: the insert provides every NOT-NULL column the real table requires.
const sqlite = databaseFactory.sqlite;

beforeAll(() => {
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS media_files (
			id TEXT PRIMARY KEY,
			library_id TEXT NOT NULL,
			metadata_id TEXT NOT NULL,
			movie_id TEXT,
			episode_id TEXT,
			file_path TEXT NOT NULL,
			file_name TEXT NOT NULL,
			is_default INTEGER NOT NULL DEFAULT 0,
			is_enabled INTEGER NOT NULL DEFAULT 1,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
});

beforeEach(() => {
	sqlite.run("DELETE FROM media_files");
});

function insertFile(id: string, options: { movieId?: string; episodeId?: string; isDefault?: boolean } = {}): void {
	const now = Math.floor(Date.now() / 1000);
	sqlite.run(
		"INSERT INTO media_files (id, library_id, metadata_id, movie_id, episode_id, file_path, file_name, is_default, is_enabled, created_at, updated_at) VALUES (?, 'lib-1', 'meta-1', ?, ?, ?, ?, ?, 1, ?, ?)",
		[id, options.movieId ?? null, options.episodeId ?? null, `/media/${id}.mkv`, `${id}.mkv`, options.isDefault ? 1 : 0, now, now],
	);
}

function defaultFlags(): Record<string, number> {
	const rows = sqlite.query("SELECT id, is_default FROM media_files ORDER BY id").all();
	return Object.fromEntries(
		rows.map((row) => {
			if (typeof row !== "object" || row === null) return ["", 0];
			const record = row as Record<string, unknown>;

			return [String(record.id), Number(record.is_default)];
		}),
	);
}

/** Counts `update` calls on the client setDefault receives, without touching the real chain. */
function countingGetClient(): { updates: () => number; restore: () => void } {
	const realClient = databaseFactory.getClient();
	let updates = 0;
	const countingClient = new Proxy(realClient, {
		get(target, property, receiver) {
			if (property === "update") {
				const original = Reflect.get(target, property, receiver) as (...args: unknown[]) => unknown;

				return (...args: unknown[]) => {
					updates += 1;

					return original.apply(target, args);
				};
			}

			return Reflect.get(target, property, receiver);
		},
	});
	const stub = stubMethod(databaseFactory, "getClient", () => countingClient);

	return { updates: () => updates, restore: () => stub.restore() };
}

describe("mediaRepository.setDefault", () => {
	test("swaps the default flag with a single update", async () => {
		insertFile("mf-a", { movieId: "movie-1", isDefault: true });
		insertFile("mf-b", { movieId: "movie-1" });

		const counter = countingGetClient();
		try {
			await mediaRepository.setDefault("mf-b", true, databaseFactory.getClient());

			expect(counter.updates()).toBe(1);
		} finally {
			counter.restore();
		}

		expect(defaultFlags()).toEqual({ "mf-a": 0, "mf-b": 1 });
	});

	test("unsetting a non-default file leaves the current default untouched", async () => {
		insertFile("mf-a", { movieId: "movie-1", isDefault: true });
		insertFile("mf-b", { movieId: "movie-1" });

		const counter = countingGetClient();
		try {
			await mediaRepository.setDefault("mf-b", false, databaseFactory.getClient());

			expect(counter.updates()).toBe(1);
		} finally {
			counter.restore();
		}

		expect(defaultFlags()).toEqual({ "mf-a": 1, "mf-b": 0 });
	});

	test("is a no-op for a missing media file", async () => {
		const counter = countingGetClient();
		try {
			await mediaRepository.setDefault("mf-missing", true, databaseFactory.getClient());

			expect(counter.updates()).toBe(0);
		} finally {
			counter.restore();
		}
	});
});
