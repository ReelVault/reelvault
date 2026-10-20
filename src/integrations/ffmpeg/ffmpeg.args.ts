/**
 * The FFmpeg arguments every command starts with.
 *
 * `-hide_banner` drops the build banner, `-loglevel` sets how much FFmpeg
 * prints, and `-stats` keeps the progress line the transcoding monitor parses.
 * Splitting them keeps the two policies apart: a short-lived diagnostic runs
 * quiet, a transcode keeps the stats line.
 */

/** Quiet mode: no banner, errors only. Used by short-lived diagnostics and extractions. */
export const FFMPEG_QUIET_ARGS: readonly string[] = ["-hide_banner", "-loglevel", "error"];

/** Streaming mode: keep the stats line the progress monitor parses. */
export const FFMPEG_GLOBAL_ARGS: readonly string[] = ["-hide_banner", "-loglevel", "warning", "-stats"];
