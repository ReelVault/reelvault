import type { CreateSubtitleRequest, Subtitle, SubtitleType } from "@reelvault/sdk/common";
import { DomainError } from "@/utils/domain.errors";
import { serializeDate } from "@/utils/time.utils";
import { isBitmapSubtitleFormat } from "./extract/ffmpeg-args.builder";

export function resolveSubtitleType(body: Pick<Partial<CreateSubtitleRequest>, "sourcePath" | "streamIndex" | "type">): SubtitleType {
	const hasSourcePath = body.sourcePath !== undefined;
	const hasStreamIndex = body.streamIndex !== undefined;
	if (hasSourcePath === hasStreamIndex)
		throw new DomainError("validation", "Subtitle must have exactly one of sourcePath or streamIndex", { code: "subtitle.source_invalid" });

	const inferredType: SubtitleType = hasSourcePath ? "external" : "embedded";
	if (body.type && body.type !== inferredType)
		throw new DomainError("validation", `Subtitle type ${body.type} does not match its source`, { code: "subtitle.type_mismatch" });

	return body.type ?? inferredType;
}

/** Embedded image-based tracks (PGS, VobSub) cannot be served as text, so clients must not offer them. */
export function isTextExtractable(subtitle: { type: string; format: string }): boolean {
	return subtitle.type !== "embedded" || !isBitmapSubtitleFormat(subtitle.format);
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
		extractable: isTextExtractable(subtitle),
		isDefault: subtitle.isDefault,
		isForced: subtitle.isForced,
		isHearingImpaired: subtitle.isHearingImpaired,
		createdAt: serializeDate(subtitle.createdAt),
		updatedAt: serializeDate(subtitle.updatedAt),
	};
}
