export const SCAN_FINDING_REASONS = ["recognition_failed", "type_mismatch", "no_metadata_match", "probe_failed"] as const;
export type ScanFindingReason = (typeof SCAN_FINDING_REASONS)[number];
