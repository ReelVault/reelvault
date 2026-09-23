import { t } from "elysia";
import { ClampedNumeric } from "@/api/schemas/common.schemas";

export const RefreshMetadataSchema = t.Object(
	{
		metadataId: t.Optional(
			t.String({ description: "Metadata ID to refresh. If omitted, refreshes all metadata and downloads missing images." }),
		),
		metadataIds: t.Optional(
			t.Array(t.String(), {
				description: "Batch of metadata IDs to refresh (e.g. the missing-translation admin filter). Takes precedence over metadataId.",
			}),
		),
	},
	{
		description: "Request to manually trigger metadata refresh and download images",
	},
);

export const AdminLogsQuerySchema = t.Object({
	fileId: t.Optional(t.String()),
	level: t.Optional(t.String({ description: "Filter by log level or comma-separated levels (e.g. 'warn,error,fatal')." })),
	search: t.Optional(t.String()),
	limit: t.Optional(ClampedNumeric(1, 100, { default: 100 })),
	page: t.Optional(ClampedNumeric(1, 1000, { default: 1 })),
});
