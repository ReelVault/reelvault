import { and, eq, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { schema } from "@/database/schema";

/** ON condition joining `metadata` to a row's metadata id column. */
export function metadataOn(metadataIdColumn: SQLiteColumn): SQL {
	return eq(schema.metadata.id, metadataIdColumn);
}

/** ON condition for the poster row of a metadata id column in `metadata_images`. */
export function posterImagesOn(metadataIdColumn: SQLiteColumn): SQL | undefined {
	return and(eq(schema.metadataImages.metadataId, metadataIdColumn), eq(schema.metadataImages.imageType, "poster"));
}

/** ON condition joining `images` to `metadata_images.imageId`. */
export const metadataImageOn = eq(schema.images.id, schema.metadataImages.imageId);
