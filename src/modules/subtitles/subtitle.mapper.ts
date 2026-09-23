import type { CreateSubtitleRequest, Subtitle, SubtitleType } from "@sdk/common";
import { ValidationError } from "@/utils/errors";
import { serializeDate } from "@/utils/time.utils";

export function resolveSubtitleType(body: Pick<Partial<CreateSubtitleRequest>, "sourcePath" | "streamIndex" | "type">): SubtitleType {
	const hasSourcePath = body.sourcePath !== undefined;
	const hasStreamIndex = body.streamIndex !== undefined;
	if (hasSourcePath === hasStreamIndex) throw new ValidationError("Subtitle must have exactly one of sourcePath or streamIndex");

	const inferredType: SubtitleType = hasSourcePath ? "external" : "embedded";
	if (body.type && body.type !== inferredType) throw new ValidationError(`Subtitle type ${body.type} does not match its source`);

	return body.type ?? inferredType;
}

export function toPublicSubtitle(subtitle: {
	id: string;
	mediaFileId: string;
	language: string;
	label: string | null;
	format: string;
	type: string;
	streamIndex: number | null;
	isDefault: boolean;
	isForced: boolean;
	isHearingImpaired: boolean;
	createdAt: Date | string;
	updatedAt: Date | string;
}): Subtitle {
	return {
		id: subtitle.id,
		mediaFileId: subtitle.mediaFileId,
		language: subtitle.language,
		label: subtitle.label,
		format: subtitle.format,
		type: subtitle.type === "embedded" ? "embedded" : "external",
		streamIndex: subtitle.streamIndex,
		isDefault: subtitle.isDefault,
		isForced: subtitle.isForced,
		isHearingImpaired: subtitle.isHearingImpaired,
		createdAt: serializeDate(subtitle.createdAt),
		updatedAt: serializeDate(subtitle.updatedAt),
	};
}
