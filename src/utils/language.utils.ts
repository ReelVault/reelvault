/**
 * ISO 639 language tag with an optional region: "pl", "en-US".
 * Subtitle file names may use an underscore ("en_US") — callers normalize it
 * to a dash before matching.
 */
export const LANGUAGE_TAG_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z]{2})?$/;
