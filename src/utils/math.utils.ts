/**
 * Clamps a number between a minimum and maximum value.
 */
export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/**
 * Rounds a number to a fixed number of decimal places.
 */
export function roundTo(value: number, decimals: number): number {
	const factor = 10 ** decimals;

	return Math.round(value * factor) / factor;
}
