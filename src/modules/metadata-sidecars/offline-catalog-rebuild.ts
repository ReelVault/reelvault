import { Database } from "bun:sqlite";
import { rename } from "node:fs/promises";
import { databaseMaintenanceRepository } from "@/database/repositories/database-maintenance.repository";
import { BaseService } from "@/utils/base-service";
import { InternalError } from "@/utils/errors";
import { createTempPath, FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";
import { metadataSidecarsService } from "./metadata-sidecars.service";
import { CatalogMoviesImporter } from "./offline/catalog-movies.importer";
import { CatalogSchemaBuilder } from "./offline/catalog-schema.builder";
import { CatalogSeriesImporter } from "./offline/catalog-series.importer";
import { CatalogTreeWalker } from "./offline/catalog-tree.walker";
import type { OfflineRebuildIssue, OfflineRebuildReport } from "./offline-rebuild-report";
import type { SidecarDocumentReader } from "./sidecar.types";

interface OfflineCatalogRebuildService {
	rebuild(input: {
		libraries: Array<{ id: string; type: "movies" | "tv_shows"; paths: string[] }>;
		outputDatabasePath: string;
	}): Promise<OfflineRebuildReport>;
}

export class SqliteOfflineCatalogRebuildService extends BaseService implements OfflineCatalogRebuildService {
	private readonly readSidecarDocument: SidecarDocumentReader;
	private readonly treeWalker: CatalogTreeWalker;
	private readonly schemaBuilder: CatalogSchemaBuilder;
	private readonly moviesImporter: CatalogMoviesImporter;
	private readonly seriesImporter: CatalogSeriesImporter;

	constructor(readSidecarDocument?: SidecarDocumentReader) {
		super("SqliteOfflineCatalogRebuildService");
		this.readSidecarDocument = readSidecarDocument ?? ((path) => metadataSidecarsService.readDocument(path));
		this.treeWalker = new CatalogTreeWalker();
		this.schemaBuilder = new CatalogSchemaBuilder();
		this.moviesImporter = new CatalogMoviesImporter({ readSidecarDocument: (path) => this.readSidecarDocument(path) });
		this.seriesImporter = new CatalogSeriesImporter({ readSidecarDocument: (path) => this.readSidecarDocument(path) });
	}

	async rebuild({
		libraries,
		outputDatabasePath,
	}: {
		libraries: Array<{ id: string; type: "movies" | "tv_shows"; paths: string[] }>;
		outputDatabasePath: string;
	}): Promise<OfflineRebuildReport> {
		const temporaryPath = createTempPath(outputDatabasePath);
		const skipped: OfflineRebuildIssue[] = [];
		let importedMovies = 0;
		let importedMediaFiles = 0;
		try {
			const database = new Database(temporaryPath);
			await this.schemaBuilder.createSchema(database);
			database.run("PRAGMA foreign_keys = ON");
			for (const library of libraries) {
				const now = Date.now();
				database.run(
					"INSERT INTO libraries (id, name, type, metadata_storage_mode, created_at, updated_at) VALUES (?, ?, ?, 'database', ?, ?)",
					[library.id, library.id, library.type, now, now],
				);
				for (const path of library.paths) {
					const libraryPathId = crypto.randomUUID();
					const pathNow = Date.now();
					database.run(
						"INSERT INTO library_paths (id, library_id, stable_key, path, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
						[libraryPathId, library.id, libraryPathId, PathUtils.resolve(path), pathNow, pathNow],
					);
					const tree = await this.treeWalker.collect(path);
					const result =
						library.type === "movies"
							? await this.moviesImporter.import(database, library.id, path, tree, skipped)
							: await this.seriesImporter.import(database, library.id, path, tree, skipped);
					importedMovies += result.entries;
					importedMediaFiles += result.mediaFiles;
				}
			}

			const foreignKeyErrors = database.query("PRAGMA foreign_key_check").all();
			database.close();
			if (foreignKeyErrors.length > 0)
				throw new InternalError(`Offline rebuild foreign key validation failed: ${JSON.stringify(foreignKeyErrors)}`, {
					code: "database.foreign_key_violation",
				});

			databaseMaintenanceRepository.shutdownIfConfiguredDatabasePath(outputDatabasePath);
			await rename(temporaryPath, outputDatabasePath);

			return { importedMovies, importedMediaFiles, skipped };
		} catch (error) {
			await FileUtils.delete(temporaryPath);
			throw error;
		}
	}
}
