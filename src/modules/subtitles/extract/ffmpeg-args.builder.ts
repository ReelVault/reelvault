export function buildWebVttExtractionArgs(mediaFilePath: string, streamIndex: number, outputFilePath: string): string[] {
	return ["-nostdin", "-loglevel", "error", "-y", "-i", mediaFilePath, "-map", `0:${streamIndex}`, "-f", "webvtt", outputFilePath];
}
