import { isFiniteNumber, isNonEmptyString } from "./type.utils";

/**
 * Clamps a number between a minimum and maximum value.
 */
export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/**
 * Checks whether a rating has a non-empty source and a finite numeric value.
 */
export function isValidRating(rating: { source: string; value: number }): boolean {
	return isNonEmptyString(rating.source) && isFiniteNumber(rating.value);
}
