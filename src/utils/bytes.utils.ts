/**
 * The byte units the server sizes its budgets in. Writing them once keeps a
 * "4 MB limit" from meaning "4 × 1024 bytes" somewhere and "4 × 1024²" next
 * door.
 */
export const KIB = 1024;
export const MIB = KIB * 1024;
export const GIB = MIB * 1024;
