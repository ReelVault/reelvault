import { readdir } from "node:fs/promises";
import { systemResourcesService } from "@/system/system-resources.service";
import { BaseService } from "@/utils/base-service";
import { errorMessage } from "@/utils/errors";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";

export interface CatalogDirectoryNode {
	readonly files: string[];
	readonly subdirectories: string[];
}

export interface CatalogTreeEntry {
	readonly name: string;
	readonly isFile: boolean;
	readonly isDirectory: boolean;
}

interface ServiceDependencies {
	listEntries: (directory: string) => Promise<readonly CatalogTreeEntry[]>;
	getIoConcurrency: () => number;
}

const defaultDependencies: ServiceDependencies = {
	listEntries: async (directory) => {
		const entries = await readdir(directory, { withFileTypes: true });

		return entries.map((entry) => ({ name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory() }));
	},
	getIoConcurrency: () => systemResourcesService.getIoConcurrency(),
};

/**
 * Walks a library root once and groups every file/directory by its parent path,
 * so per-document lookups (video files next to a movie/series document) don't
 * re-traverse the tree.
 */
export class CatalogTreeWalker extends BaseService {
	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		super("CatalogTreeWalker");
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
				const joined = PathUtils.join(directory, entry.name);
				if (entry.isFile) files.push(joined);
				else if (entry.isDirectory) subdirectories.push(joined);
			}

			tree.set(directory, { files, subdirectories });
			// Bounded walk: an unbounded Promise.all over a deep tree queues one
			// readdir per directory at once (slow NAS/SD starvation).
			await PromiseUtils.mapConcurrent(subdirectories, this.dependencies.getIoConcurrency(), async (subdirectory) => {
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
