import type { PluginMediaFile } from "@reelvault/sdk/common";
import type { MediaAnalysis, MediaAnalyzer } from "@reelvault/sdk/plugin";
import { systemResourcesService } from "@/config/system-resources.service";
import { createLogger } from "@/utils/logger.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { PluginEntityTable } from "./plugin-entity.registry";

/** Runs every registered analyzer against a media file, isolating per-analyzer failures. */
export class MediaAnalysisFanout {
	readonly logger = createLogger("MediaAnalysisFanout");
	private readonly table = new PluginEntityTable<MediaAnalyzer>("Media analyzer");

	assertRegisterable(analyzers: readonly MediaAnalyzer[]): void {
		this.table.assertRegisterable(analyzers);
	}

	register(pluginId: string, analyzers: readonly MediaAnalyzer[]): void {
		this.table.register(pluginId, analyzers);
	}

	removeForPlugin(pluginId: string): void {
		this.table.removeForPlugin(pluginId);
	}

	clear(): void {
		this.table.clear();
	}

	async analyze(media: PluginMediaFile): Promise<MediaAnalysis> {
		// The analyzers run side by side — each one probes the file, so running
		// them one after another made the analysis as slow as the sum of its
		// parts. The results are merged in registration order, so a later
		// analyzer still wins.
		const analyses = await PromiseUtils.mapConcurrent(this.table.getAll(), systemResourcesService.getIoConcurrency(), async (analyzer) => {
			try {
				return normalizeMediaAnalysis(await analyzer.analyze({ media, logger: createLogger(`MediaAnalyzer:${analyzer.id}`) }));
			} catch (error) {
				this.logger.error(`Media analyzer ${analyzer.id} failed`, error);

				return {};
			}
		});

		const result: MediaAnalysis = {};
		for (const analysis of analyses) Object.assign(result, analysis);

		return result;
	}
}

function normalizeMediaAnalysis(analysis: MediaAnalysis | undefined): MediaAnalysis {
	if (!analysis) return {};

	const result: MediaAnalysis = {};

	const source = normalizeAnalysisValue(analysis.source);
	if (source !== undefined) result.source = source;

	const edition = normalizeAnalysisValue(analysis.edition);
	if (edition !== undefined) result.edition = edition;

	const qualityTag = normalizeAnalysisValue(analysis.qualityTag);
	if (qualityTag !== undefined) result.qualityTag = qualityTag;

	return result;
}

function normalizeAnalysisValue(value: string | null | undefined): string | null | undefined {
	if (value == null) return value;

	return value.trim() || null;
}
