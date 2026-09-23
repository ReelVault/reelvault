import type { PluginMediaFile } from "@sdk/common";
import type { MediaAnalysis, MediaAnalyzer } from "@sdk/plugin";
import { ValidationError } from "@/utils/errors";
import { createLogger } from "@/utils/logger";

interface AnalyzerEntry {
	pluginId: string;
	analyzer: MediaAnalyzer;
}

/** Runs every registered analyzer against a media file, isolating per-analyzer failures. */
export class MediaAnalysisFanout {
	private readonly logger = createLogger("MediaAnalysisFanout");
	private readonly analyzers = new Map<string, AnalyzerEntry>();

	assertRegisterable(analyzers: readonly MediaAnalyzer[]): void {
		for (const analyzer of analyzers) {
			if (this.analyzers.has(analyzer.id)) {
				throw new ValidationError(
					`Media analyzer "${analyzer.id}" is already registered by plugin "${this.analyzers.get(analyzer.id)?.pluginId ?? "unknown"}"`,
				);
			}
		}
	}

	register(pluginId: string, analyzers: readonly MediaAnalyzer[]): void {
		for (const analyzer of analyzers) this.analyzers.set(analyzer.id, { pluginId, analyzer });
	}

	removeForPlugin(pluginId: string): void {
		for (const [key, entry] of this.analyzers) {
			if (entry.pluginId === pluginId) this.analyzers.delete(key);
		}
	}

	clear(): void {
		this.analyzers.clear();
	}

	async analyze(media: PluginMediaFile): Promise<MediaAnalysis> {
		const result: MediaAnalysis = {};

		for (const { analyzer } of this.analyzers.values()) {
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
