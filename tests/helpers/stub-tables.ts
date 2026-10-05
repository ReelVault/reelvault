/**
 * Stub tables mirror the drizzle column NAMES exactly (drizzle selects every
 * declared column), but deliberately omit constraints — raw seed rows are the
 * only writes. Never migrate the shared test database (AGENTS.md); these
 * CREATE TABLE IF NOT EXISTS stubs are the established idiom instead.
 */
export const LIBRARIES_STUB_TABLE = `CREATE TABLE IF NOT EXISTS libraries (
		id TEXT PRIMARY KEY, name TEXT, type TEXT, metadata_storage_mode TEXT, sidecar_flavor TEXT NOT NULL DEFAULT 'reelvault', metadata_language TEXT,
		created_at INTEGER, updated_at INTEGER
	)`;

export const LIBRARY_PATHS_STUB_TABLE = `CREATE TABLE IF NOT EXISTS library_paths (
		id TEXT PRIMARY KEY, library_id TEXT, stable_key TEXT, path TEXT,
		is_active INTEGER, metadata_storage_mode TEXT, created_at INTEGER, updated_at INTEGER
	)`;

export const MEDIA_FILES_STUB_TABLE = `CREATE TABLE IF NOT EXISTS media_files (
		id TEXT PRIMARY KEY, library_id TEXT, metadata_id TEXT, movie_id TEXT, episode_id TEXT,
		file_path TEXT, file_name TEXT, format_name TEXT, duration INTEGER, file_size INTEGER,
		source_mtime_ms INTEGER, bit_rate INTEGER, source TEXT, edition TEXT, quality_tag TEXT,
		is_default INTEGER, is_enabled INTEGER, created_at INTEGER, updated_at INTEGER
	)`;
