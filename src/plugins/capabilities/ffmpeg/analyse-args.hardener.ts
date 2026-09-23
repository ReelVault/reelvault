import { getEffectiveHwaccel, hardwareDecodeArgs } from "@/integrations/ffmpeg/ffmpeg.capabilities";
import { serverConfig } from "@/server.config";
import { ValidationError } from "@/utils/errors";
import { PathUtils } from "@/utils/path.utils";

/** Flags that read a caller-supplied local file outside the media input. */
const BANNED_ANALYSE_FLAGS = new Set(["-attach", "-dump_attachment", "-filter_script", "-filter_complex_script"]);
/** Filter constructs that open arbitrary files (`movie=`/`amovie=`/`subtitles=`/`textfile=`). */
const BANNED_FILTER_TOKENS_RE = /movie=|amovie=|subtitles=|ass=|textfile=/i;
/** Demuxers that read a list of files (arbitrary local file read via a crafted list). */
const BANNED_INPUT_FORMATS = new Set(["data", "concat"]);

/** Prefers captured stderr; falls back to the exit code when stderr is empty or missing. */
export function processFailureDetail(stderr: string | null, exitCode: number | null, label: string): string {
	if (stderr !== null && stderr !== "") return stderr;

	return `${label} exited with code ${exitCode ?? "unknown"}`;
}

/**
 * Hardens plugin-supplied analysis argv: rejects banned flags/filters/formats,
 * restricts every input to a local-file protocol whitelist (blocks http/rtsp/…
 * SSRF), optionally adds hardware decode args, and requires the final output to
 * stay inside server-managed directories.
 */
export function hardenAnalyseArgs(args: string[], hardwareDecode: boolean): string[] {
	if (args.includes("-protocol_whitelist")) {
		throw new ValidationError("runAnalyse manages -protocol_whitelist itself", { code: "plugin.ffmpeg.security_violation" });
	}

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === undefined) continue;

		if (BANNED_ANALYSE_FLAGS.has(arg)) {
			throw new ValidationError(`runAnalyse does not allow ${arg}`, { code: "plugin.ffmpeg.security_violation" });
		}

		if (arg === "-f" && BANNED_INPUT_FORMATS.has(args[index + 1] ?? "")) {
			throw new ValidationError(`runAnalyse does not allow the '${args[index + 1] ?? "unknown"}' input format`, {
				code: "plugin.ffmpeg.security_violation",
			});
		}

		if (BANNED_FILTER_TOKENS_RE.test(arg)) {
			throw new ValidationError("runAnalyse does not allow filters that open files", { code: "plugin.ffmpeg.security_violation" });
		}
	}

	const hwArgs = hardwareDecode ? hardwareDecodeArgs(getEffectiveHwaccel()) : [];
	const hardened: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === undefined) continue;

		if (arg === "-i") {
			// Per-input options: restrict every input to local files (blocks http/rtsp/… SSRF),
			// optionally decode with the server-configured hardware accelerator.
			hardened.push("-protocol_whitelist", "file,crypto");
			hardened.push(...hwArgs);
		}

		hardened.push(arg);
	}

	const last = args.at(-1);
	if (last && last !== "-" && !last.startsWith("-")) {
		const outputPath = PathUtils.resolve(last);
		const allowedRoots = [serverConfig.paths.transcodes, serverConfig.paths.subtitles];
		if (!allowedRoots.some((root) => PathUtils.isSubpath(outputPath, PathUtils.resolve(root)))) {
			throw new ValidationError("runAnalyse output must stay inside server-managed temporary directories", {
				code: "plugin.ffmpeg.security_violation",
			});
		}
	}

	return hardened;
}
