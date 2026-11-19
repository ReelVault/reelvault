import { selectDefaultOrFirstStream } from "@/modules/streaming/utils/stream-selection.utils";
import { isNullish } from "@/utils/type.utils";

/** The audio stream a session plays: the one it selected by index, else the default or the first one. */
export function selectTargetAudioStream<T extends { index: number; isDefault: boolean }>(
	audioStreams: readonly T[],
	selectedAudioIndex: number | null | undefined,
): T | undefined {
	const defaultAudioStream = selectDefaultOrFirstStream(audioStreams);
	if (isNullish(selectedAudioIndex)) return defaultAudioStream;

	return audioStreams.find((stream) => stream.index === selectedAudioIndex) ?? defaultAudioStream;
}
