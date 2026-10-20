import { systemResourcesService } from "@/config/system-resources.service";
import { type DirectoryEntry, readDirectoryEntries } from "@/utils/directory.utils";
import { errorMessage } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { getFileName, joinPath } from "@/utils/path.utils";
import { mapConcurrent } from "@/utils/promise.utils";

export interface CatalogDirectoryNode {
	readonly files: string[];
	readonly subdirectories: string[];
}

interface ServiceDependencies {
	listEntries: (directory: string) => Promise<readonly DirectoryEntry[]>;
	getIoConcurrency: () => number;
}

const defaultDependencies: ServiceDependencies = {
	listEntries: readDirectoryEntries,
	getIoConcurrency: () => systemResourcesService.getIoConcurrency(),
};

/**
 * Walks a library root once and groups every file/directory by its parent path,
 * so per-document lookups (video files next to a movie/series document) don't
 * re-traverse the tree.
 */
export class CatalogTreeWalker {
	readonly serviceName = "CatalogTreeWalker";
	readonly logger = createLogger("CatalogTreeWalker");

	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		this.dependencies = dependencies;
	}

	async collect(root: string): Promise<Map<string, CatalogDirectoryNode>> {
		const tree = new Map<string, CatalogDirectoryNode>();
		const visit = async (directory: string): Promise<void> => {
			const entries = await this.dependencies.listEntries(directory).catch((error) => {
				// An unreadable directory must not masquerade as an empty one during a
				// full catalog rebuild — the missing files would be undiagnosable.
				this.logger.warn("Directory unreadable during catalog rebuild — treated as empty", {
					directory,
					error: errorMessage(error),
				});

				return [];
			});
			const files: string[] = [];
			const subdirectories: string[] = [];
			for (const entry of entries) {
				const joined = joinPath(directory, entry.name);
				if (entry.isFile) files.push(joined);
				else if (entry.isDirectory) subdirectories.push(joined);
			}

			tree.set(directory, { files, subdirectories });
			// Bounded walk: an unbounded Promise.all over a deep tree queues one
			// readdir per directory at once (slow NAS/SD starvation).
			await mapConcurrent(subdirectories, this.dependencies.getIoConcurrency(), async (subdirectory) => {
				await visit(subdirectory);
			});
		};
		await visit(root);

		return tree;
	}
}

export function findMatchingFiles(
	tree: ReadonlyMap<string, CatalogDirectoryNode>,
	directory: string,
	match: (path: string) => boolean,
	options: { recursive?: boolean } = {},
): string[] {
	const matched: string[] = [];
	const visit = (current: string): void => {
		const node = tree.get(current);
		if (!node) return;

		for (const filePath of node.files) {
			if (match(filePath)) matched.push(filePath);
		}

		if (options.recursive === false) return;

		for (const subdirectory of node.subdirectories) visit(subdirectory);
	};
	visit(directory);

	return matched;
}

/** Finds sidecar documents by file name (case-insensitive) anywhere below the root. */
export function findDocumentsByNames(tree: ReadonlyMap<string, CatalogDirectoryNode>, root: string, names: readonly string[]): string[] {
	const normalizedNames = new Set(names.map((name) => name.toLowerCase()));

	return findMatchingFiles(tree, root, (path) => normalizedNames.has(getFileName(path).toLowerCase()));
}
