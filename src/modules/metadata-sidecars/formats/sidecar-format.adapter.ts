import type { CanonicalSidecarDocument, SidecarFormatInput, SidecarFormatOutput, SidecarWriteResult } from "../sidecar.types";

export interface SidecarFormatAdapter {
	readonly id: string;
	readonly capabilities: ReadonlyArray<"read" | "write">;

	/** Only required for adapters declaring the "read" capability. */
	canRead?(input: SidecarFormatInput): Promise<boolean>;
	read?(input: SidecarFormatInput): Promise<CanonicalSidecarDocument | null>;
	/** Only required for adapters declaring the "write" capability. */
	write?(input: SidecarFormatOutput): Promise<SidecarWriteResult>;
}
