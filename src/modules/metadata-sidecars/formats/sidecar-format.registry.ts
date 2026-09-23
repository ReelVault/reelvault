import { ConflictError } from "@/utils/errors";
import type { SidecarFormatInput } from "../sidecar.types";
import type { SidecarFormatAdapter } from "./sidecar-format.adapter";

export interface SidecarFormatRegistry {
	register(adapter: SidecarFormatAdapter): void;
	find(id: string): SidecarFormatAdapter | undefined;
	findReader(input: SidecarFormatInput): Promise<SidecarFormatAdapter | undefined>;
}

export class InMemorySidecarFormatRegistry implements SidecarFormatRegistry {
	private readonly adapters = new Map<string, SidecarFormatAdapter>();

	register(adapter: SidecarFormatAdapter): void {
		if (this.adapters.has(adapter.id)) {
			throw new ConflictError(`A sidecar format adapter with id '${adapter.id}' is already registered`, {
				code: "sidecar.adapter_already_registered",
			});
		}

		this.adapters.set(adapter.id, adapter);
	}

	find(id: string): SidecarFormatAdapter | undefined {
		return this.adapters.get(id);
	}

	async findReader(input: SidecarFormatInput): Promise<SidecarFormatAdapter | undefined> {
		for (const adapter of this.adapters.values()) {
			if (adapter.capabilities.includes("read") && (await adapter.canRead?.(input))) return adapter;
		}

		return undefined;
	}
}
