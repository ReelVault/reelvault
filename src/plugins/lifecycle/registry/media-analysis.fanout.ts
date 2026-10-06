import type { PluginMediaFile } from "@reelvault/sdk/common";
import type { MediaAnalysis, MediaAnalyzer } from "@reelvault/sdk/plugin";
import { createLogger } from "@/utils/logger";
import { PluginEntityTable } from "./plugin-entity-table";

/** Runs every registered analyzer against a media file, isolating per-analyzer failures. */
export class MediaAnalysisFanout {
	private readonly logger = createLogger("MediaAnalysisFanout");
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
		const result: MediaAnalysis = {};

		for (const analyzer of this.table.getAll()) {
			try {
				const analysis = normalizeMediaAnalysis(await analyzer.analyze({ media, logger: createLogger(`MediaAnalyzer:${analyzer.id}`) }));
				Object.assign(result, analysis);
			} catch (error) {
				this.logger.error(`Media analyzer ${analyzer.id} failed`, error);
			}
		}

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
