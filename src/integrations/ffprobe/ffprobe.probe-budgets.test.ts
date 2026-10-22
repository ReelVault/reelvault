import { describe, expect, test } from "bun:test";
import { probeBudgetForFormat } from "./ffprobe.probe-budgets";

describe("probe budgets", () => {
	test.each([
		{ container: "MP4", formatName: "mov,mp4,m4a,3gp,3g2,mj2", analyzeduration: "10M", probesize: "10M" },
		{ container: "Matroska", formatName: "matroska,webm", analyzeduration: "20M", probesize: "20M" },
		{ container: "MPEG-TS", formatName: "mpegts", analyzeduration: "50M", probesize: "100M" },
		{ container: "unidentified", formatName: null, analyzeduration: "50M", probesize: "100M" },
	])("sets the probe budget for a $container file", ({ formatName, analyzeduration, probesize }) => {
		expect(probeBudgetForFormat(formatName)).toEqual({ analyzeduration, probesize });
	});
});
