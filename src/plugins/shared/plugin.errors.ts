import { DomainError } from "@/utils/domain.errors";

/** The error for a plugin id that is neither loaded nor present on disk. */
export function pluginNotFoundError(pluginId: string): DomainError {
	return new DomainError("not_found", `Plugin not found: ${pluginId}`, { code: "plugin.not_found", params: { pluginId } });
}
