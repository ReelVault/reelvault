export interface FFProbeDisposition {
	default?: number | undefined;
	dub?: number | undefined;
	original?: number | undefined;
	comment?: number | undefined;
	lyrics?: number | undefined;
	karaoke?: number | undefined;
	forced?: number | undefined;
	hearing_impaired?: number | undefined;
	visual_impaired?: number | undefined;
	clean_effects?: number | undefined;
	attached_pic?: number | undefined;
	timed_thumbnails?: number | undefined;
	non_diegetic?: number | undefined;
	captions?: number | undefined;
	descriptions?: number | undefined;
	metadata?: number | undefined;
	dependent?: number | undefined;
	still_image?: number | undefined;
	multilayer?: number | undefined;
	[key: string]: number | undefined;
}

/** ffprobe `side_data_list` entries — only the fields we consume are modelled. */
export interface FFProbeSideData {
	side_data_type?: string | undefined;
	/** Dolby Vision configuration record — present when `side_data_type` is "DOVI configuration record". */
	dv_profile?: number | undefined;
	dv_level?: number | undefined;
}

export interface VideoStream {
	index: number;
	codec_name: string;
	codec_type: "video";
	width: number;
	height: number;
	disposition?: FFProbeDisposition | undefined;
	codec_long_name?: string | undefined;
	profile?: string | undefined;
	codec_tag_string?: string | undefined;
	codec_tag?: string | undefined;
	mime_codec_string?: string | undefined;
	coded_width?: number | undefined;
	coded_height?: number | undefined;
	has_b_frames?: number | undefined;
	sample_aspect_ratio?: string | undefined;
	display_aspect_ratio?: string | undefined;
	pix_fmt?: string | undefined;
	/** HDR marker: `smpte2084` (HDR10/PQ), `arib-std-b67` (HLG). */
	color_transfer?: string | undefined;
	color_primaries?: string | undefined;
	color_space?: string | undefined;
	level?: number | undefined;
	chroma_location?: string | undefined;
	field_order?: string | undefined;
	is_avc?: string | undefined;
	nal_length_size?: string | undefined;
	r_frame_rate?: string | undefined;
	avg_frame_rate?: string | undefined;
	time_base?: string | undefined;
	start_pts?: number | undefined;
	start_time?: string | undefined;
	bits_per_raw_sample?: string | undefined;
	bit_rate?: string | undefined;
	extradata_size?: number | undefined;
	side_data_list?: FFProbeSideData[] | undefined;
	tags?: Record<string, string | undefined> | undefined;
}

export interface FfprobeAudioStream {
	index: number;
	codec_name: string;
	codec_type: "audio";
	channels: number;
	disposition?: FFProbeDisposition | undefined;
	codec_long_name?: string | undefined;
	codec_tag_string?: string | undefined;
	codec_tag?: string | undefined;
	mime_codec_string?: string | undefined;
	sample_fmt?: string | undefined;
	sample_rate?: string | undefined;
	channel_layout?: string | undefined;
	bits_per_sample?: number | undefined;
	initial_padding?: number | undefined;
	dmix_mode?: string | undefined;
	ltrt_cmixlev?: string | undefined;
	ltrt_surmixlev?: string | undefined;
	loro_cmixlev?: string | undefined;
	loro_surmixlev?: string | undefined;
	r_frame_rate?: string | undefined;
	avg_frame_rate?: string | undefined;
	time_base?: string | undefined;
	start_pts?: number | undefined;
	start_time?: string | undefined;
	bit_rate?: string | undefined;
	tags?: Record<string, string | undefined> | undefined;
}

export interface SubtitleStream {
	index: number;
	codec_name: string;
	codec_type: "subtitle";
	disposition?: FFProbeDisposition | undefined;
	codec_long_name?: string | undefined;
	codec_tag_string?: string | undefined;
	codec_tag?: string | undefined;
	r_frame_rate?: string | undefined;
	avg_frame_rate?: string | undefined;
	time_base?: string | undefined;
	start_pts?: number | undefined;
	start_time?: string | undefined;
	duration_ts?: number | undefined;
	duration?: string | undefined;
	tags?: Record<string, string | undefined> | undefined;
}

export type FFProbeStream = VideoStream | FfprobeAudioStream | SubtitleStream;

export interface FFProbeChapter {
	id?: number | undefined;
	time_base?: string | undefined;
	start?: number | undefined;
	start_time: string;
	end?: number | undefined;
	end_time: string;
	tags?: Record<string, string | undefined> | undefined;
}

export interface FFProbeFormat {
	filename?: string | undefined;
	nb_streams?: number | undefined;
	nb_programs?: number | undefined;
	nb_stream_groups?: number | undefined;
	format_name?: string | undefined;
	format_long_name?: string | undefined;
	start_time?: string | undefined;
	duration?: string | undefined;
	size?: string | undefined;
	bit_rate?: string | undefined;
	probe_score?: number | undefined;
	tags?:
		| {
				encoder?: string | undefined;
				creation_time?: string | undefined;
				[key: string]: string | undefined;
		  }
		| undefined;
}

export interface FFProbeResult {
	format: FFProbeFormat;
	streams: FFProbeStream[];
	chapters?: FFProbeChapter[] | undefined;
	packets?: FFProbePacket[] | undefined;
}

export interface FFProbePacket {
	pts_time?: string | undefined;
	flags?: string | undefined;
}

export interface ProbeBudget {
	analyzeduration: string;
	probesize: string;
}
