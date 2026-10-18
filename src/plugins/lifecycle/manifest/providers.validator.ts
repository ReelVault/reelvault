import { DomainError } from "@/utils/domain.errors";
import { isRecord } from "@/utils/type.utils";
import { assertSafePluginSubPath, assertUiId } from "./shared.utils";

/** The pre-play declaration only carries a relative plugin route path. */
export function validatePlaybackPreRoll(value: unknown): asserts value is { endpoint: string } {
	if (!isRecord(value))
		throw new DomainError("validation", "Plugin ui.json playbackPreRoll must be an object", {
			code: "plugin.ui.field_not_object",
			params: { field: "playbackPreRoll" },
		});

	assertSafePluginSubPath(value.endpoint, "ui.playbackPreRoll.endpoint");
}

/** Search extension: query route, optional request route and an item page reference. */
export function validateSearchProvider(
	value: unknown,
	pageIds: ReadonlySet<string>,
): asserts value is { endpoint: string; requestEndpoint?: string; itemPage?: string } {
	if (!isRecord(value))
		throw new DomainError("validation", "Plugin ui.json searchProvider must be an object", {
			code: "plugin.ui.field_not_object",
			params: { field: "searchProvider" },
		});

	assertSafePluginSubPath(value.endpoint, "ui.searchProvider.endpoint");
	if (value.requestEndpoint !== undefined) assertSafePluginSubPath(value.requestEndpoint, "ui.searchProvider.requestEndpoint");

	if (value.itemPage !== undefined) {
		assertUiId(value.itemPage, "ui.searchProvider.itemPage");
		if (!pageIds.has(value.itemPage)) {
			throw new DomainError("validation", `Plugin ui.json searchProvider.itemPage references unknown page '${value.itemPage}'`, {
				code: "plugin.ui.page_unknown",
				params: { page: value.itemPage },
			});
		}
	}
}
