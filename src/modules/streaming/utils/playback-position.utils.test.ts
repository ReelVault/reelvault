import { describe, expect, test } from "bun:test";
import { computeProgressPercent, isCompleted, normalizePlaybackPosition } from "./playback-position.utils";

describe("playback position utils", () => {
	test("normalizePlaybackPosition collapses missing and non-finite positions to 0", () => {
		expect(normalizePlaybackPosition(undefined, 100)).toBe(0);
		expect(normalizePlaybackPosition(null, 100)).toBe(0);
		expect(normalizePlaybackPosition(Number.NaN, 100)).toBe(0);
		expect(normalizePlaybackPosition(Number.POSITIVE_INFINITY, 100)).toBe(0);
		expect(normalizePlaybackPosition(0, 100)).toBe(0);
	});

	test("normalizePlaybackPosition clamps to the duration and floors fractions", () => {
		expect(normalizePlaybackPosition(-5, 100)).toBe(0);
		expect(normalizePlaybackPosition(42.9, 100)).toBe(42);
		expect(normalizePlaybackPosition(150, 100)).toBe(100);
	});

	test("normalizePlaybackPosition keeps the raw floor when duration is unknown", () => {
		expect(normalizePlaybackPosition(30.7, 0)).toBe(30);
		expect(normalizePlaybackPosition(120, 0)).toBe(120);
	});

	test("isCompleted requires a positive duration and the 90% threshold", () => {
		expect(isCompleted(89, 100)).toBe(false);
		expect(isCompleted(90, 100)).toBe(true);
		expect(isCompleted(100, 100)).toBe(true);
		expect(isCompleted(90, 0)).toBe(false);
	});

	test("computeProgressPercent rounds and caps at 100", () => {
		expect(computeProgressPercent(0, 100)).toBe(0);
		expect(computeProgressPercent(1, 3)).toBe(33);
		expect(computeProgressPercent(150, 100)).toBe(100);
	});

	test("computeProgressPercent returns 0 for unknown duration", () => {
		expect(computeProgressPercent(50, 0)).toBe(0);
		expect(computeProgressPercent(50, null)).toBe(0);
		expect(computeProgressPercent(50, undefined)).toBe(0);
	});
});
