import type { LibraryErrorsCheckRequest, OperationQueuedResponse } from "@sdk/common";
import type { FieldsQuery, SelectFields } from "@sdk/common/fields";
import type { CreateLibrary, LibraryFilters, LibrarySorting, LibraryWithRelations, UpdateLibrary } from "@sdk/common/library.types";
import type { PaginatedResponse, PaginationQuery } from "@sdk/common/pagination";
import { BaseResource } from "../core/base-client";

export class LibrariesClient extends BaseResource {
	getAll<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & LibrarySorting & LibraryFilters,
	): Promise<PaginatedResponse<SelectFields<LibraryWithRelations, F>>> {
		return this._get("/libraries", { query });
	}

	create<F extends string>(body: CreateLibrary, query?: FieldsQuery<F>): Promise<SelectFields<LibraryWithRelations, F>> {
		return this._post("/libraries", { body, query });
	}

	getById<F extends string>(libraryId: string, query?: FieldsQuery<F>): Promise<SelectFields<LibraryWithRelations, F>> {
		return this._get(`/libraries/${libraryId}`, { query });
	}

	update<F extends string>(libraryId: string, body: UpdateLibrary, query?: FieldsQuery<F>): Promise<SelectFields<LibraryWithRelations, F>> {
		return this._patch(`/libraries/${libraryId}`, { body, query });
	}

	delete(libraryId: string): Promise<{ success: boolean }> {
		return this._delete(`/libraries/${libraryId}`);
	}

	scan(libraryId: string): Promise<OperationQueuedResponse> {
		return this._post(`/libraries/${libraryId}/scan`, { body: undefined });
	}

	scanPath(libraryId: string, pathId: string): Promise<OperationQueuedResponse> {
		return this._post(`/libraries/${libraryId}/paths/${pathId}/scan`, { body: undefined });
	}

	checkErrors(libraryPaths: LibraryErrorsCheckRequest["libraryPaths"]): Promise<OperationQueuedResponse> {
		return this._post("/libraries/check-errors", { body: { libraryPaths } });
	}

	getIgnoredAssets(libraryId: string): Promise<Array<{ path: string; fileName: string; reason: string }>> {
		return this._get(`/libraries/${libraryId}/metadata-sidecars/assets`);
	}

	getScanFindings(libraryId: string): Promise<{ items: Array<{ filePath: string; fileName: string; reason: string }> }> {
		return this._get(`/libraries/${libraryId}/scan-findings`);
	}
}
