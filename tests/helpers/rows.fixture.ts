import { eq } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { useTestDatabase } from "./test-database.helper";

/**
 * Row fixtures for application tests. Application test files seed and read rows through these
 * helpers, so the table definitions stay in this file. Each insert accepts one row or an array.
 */
export type TestClient = ReturnType<ReturnType<typeof useTestDatabase>["client"]>;

type Insertable<T extends { $inferInsert: unknown }> = T["$inferInsert"] | Array<T["$inferInsert"]>;

function rowsOf<T>(values: T | T[]): T[] {
	return Array.isArray(values) ? values : [values];
}

export type ProfileInsert = typeof schema.profiles.$inferInsert;
export type ProfileRow = typeof schema.profiles.$inferSelect;

// Users, profiles and sessions

export async function insertUsers(client: TestClient, values: Insertable<typeof schema.users>): Promise<void> {
	await client.insert(schema.users).values(rowsOf(values));
}

export async function insertProfiles(client: TestClient, values: Insertable<typeof schema.profiles>): Promise<void> {
	await client.insert(schema.profiles).values(rowsOf(values));
}

export async function insertSessions(client: TestClient, values: Insertable<typeof schema.sessions>): Promise<void> {
	await client.insert(schema.sessions).values(rowsOf(values));
}

export async function insertAccounts(client: TestClient, values: Insertable<typeof schema.accounts>): Promise<void> {
	await client.insert(schema.accounts).values(rowsOf(values));
}

export async function insertTwoFactors(client: TestClient, values: Insertable<typeof schema.twoFactors>): Promise<void> {
	await client.insert(schema.twoFactors).values(rowsOf(values));
}

export async function insertProfilePreferenceOverrides(
	client: TestClient,
	values: Insertable<typeof schema.profilePreferenceOverrides>,
): Promise<void> {
	await client.insert(schema.profilePreferenceOverrides).values(rowsOf(values));
}

export async function selectUsers(client: TestClient) {
	return await client.select().from(schema.users);
}

export async function selectProfiles(client: TestClient) {
	return await client.select().from(schema.profiles);
}

export async function selectSessions(client: TestClient) {
	return await client.select().from(schema.sessions);
}

export async function selectAccounts(client: TestClient) {
	return await client.select().from(schema.accounts);
}

export async function selectTwoFactors(client: TestClient) {
	return await client.select().from(schema.twoFactors);
}

export async function selectProfilePreferenceOverrides(client: TestClient) {
	return await client.select().from(schema.profilePreferenceOverrides);
}

export async function selectProfileStreamPrefs(client: TestClient) {
	return await client.select().from(schema.profileStreamPrefs);
}

export async function selectAdminAuditLogs(client: TestClient) {
	return await client.select().from(schema.adminAuditLogs);
}

export async function insertAdminAuditLogs(client: TestClient, values: Insertable<typeof schema.adminAuditLogs>): Promise<void> {
	await client.insert(schema.adminAuditLogs).values(rowsOf(values));
}

export async function selectUpdateHistory(client: TestClient) {
	return await client.select().from(schema.updateHistory);
}

// Notifications, worker rows and metrics

export async function insertNotifications(client: TestClient, values: Insertable<typeof schema.notifications>): Promise<void> {
	await client.insert(schema.notifications).values(rowsOf(values));
}

export async function selectNotifications(client: TestClient) {
	return await client.select().from(schema.notifications);
}

export async function insertWorkerJobs(client: TestClient, values: Insertable<typeof schema.workerJobs>): Promise<void> {
	await client.insert(schema.workerJobs).values(rowsOf(values));
}

export async function insertWorkerOperations(client: TestClient, values: Insertable<typeof schema.workerOperations>): Promise<void> {
	await client.insert(schema.workerOperations).values(rowsOf(values));
}

export async function updateWorkerOperation(
	client: TestClient,
	id: string,
	changes: Partial<typeof schema.workerOperations.$inferInsert>,
): Promise<void> {
	await client.update(schema.workerOperations).set(changes).where(eq(schema.workerOperations.id, id));
}

export async function insertResourceMetrics(client: TestClient, values: Insertable<typeof schema.resourceMetrics>): Promise<void> {
	await client.insert(schema.resourceMetrics).values(rowsOf(values));
}

export async function insertScanFindings(client: TestClient, values: Insertable<typeof schema.scanFindings>): Promise<void> {
	await client.insert(schema.scanFindings).values(rowsOf(values));
}

export async function selectScanFindings(client: TestClient) {
	return await client.select().from(schema.scanFindings);
}

// Libraries

export async function insertLibraries(client: TestClient, values: Insertable<typeof schema.libraries>): Promise<Array<{ id: string }>> {
	return await client.insert(schema.libraries).values(rowsOf(values)).returning({ id: schema.libraries.id });
}

export async function selectLibraries(client: TestClient) {
	return await client.select().from(schema.libraries);
}

export async function updateLibraryLanguage(client: TestClient, libraryId: string, metadataLanguage: string): Promise<void> {
	await client.update(schema.libraries).set({ metadataLanguage }).where(eq(schema.libraries.id, libraryId));
}

export async function insertLibraryPaths(client: TestClient, values: Insertable<typeof schema.libraryPaths>): Promise<void> {
	await client.insert(schema.libraryPaths).values(rowsOf(values));
}

export async function updateLibraryPathPath(client: TestClient, id: string, path: string): Promise<void> {
	await client.update(schema.libraryPaths).set({ path }).where(eq(schema.libraryPaths.id, id));
}

export async function deleteLibraryPath(client: TestClient, id: string): Promise<void> {
	await client.delete(schema.libraryPaths).where(eq(schema.libraryPaths.id, id));
}

// Metadata and catalog

export async function insertMetadata(client: TestClient, values: Insertable<typeof schema.metadata>): Promise<Array<{ id: string }>> {
	return await client.insert(schema.metadata).values(rowsOf(values)).returning({ id: schema.metadata.id });
}

export async function selectMetadata(client: TestClient) {
	return await client.select().from(schema.metadata);
}

export async function updateMetadataPopularity(client: TestClient, metadataId: string, popularity: number): Promise<void> {
	await client.update(schema.metadata).set({ popularity }).where(eq(schema.metadata.id, metadataId));
}

export async function insertMetadataLockedFields(
	client: TestClient,
	values: Insertable<typeof schema.metadataLockedFields>,
): Promise<void> {
	await client.insert(schema.metadataLockedFields).values(rowsOf(values));
}

export async function insertMetadataProviders(client: TestClient, values: Insertable<typeof schema.metadataProviders>): Promise<void> {
	await client.insert(schema.metadataProviders).values(rowsOf(values));
}

export async function insertProviders(client: TestClient, values: Insertable<typeof schema.providers>): Promise<Array<{ id: string }>> {
	return await client.insert(schema.providers).values(rowsOf(values)).returning({ id: schema.providers.id });
}

export async function insertSeasons(client: TestClient, values: Insertable<typeof schema.seasons>): Promise<Array<{ id: string }>> {
	return await client.insert(schema.seasons).values(rowsOf(values)).returning({ id: schema.seasons.id });
}

export async function selectSeasons(client: TestClient) {
	return await client.select().from(schema.seasons);
}

export async function insertEpisodes(client: TestClient, values: Insertable<typeof schema.episodes>): Promise<Array<{ id: string }>> {
	return await client.insert(schema.episodes).values(rowsOf(values)).returning({ id: schema.episodes.id });
}

export async function selectEpisodes(client: TestClient) {
	return await client.select().from(schema.episodes);
}

export async function selectMovies(client: TestClient) {
	return await client.select().from(schema.movies);
}

export async function insertGenres(client: TestClient, values: Insertable<typeof schema.genres>): Promise<void> {
	await client.insert(schema.genres).values(rowsOf(values));
}

export async function selectGenres(client: TestClient) {
	return await client.select().from(schema.genres);
}

export async function insertPeople(client: TestClient, values: Insertable<typeof schema.people>): Promise<void> {
	await client.insert(schema.people).values(rowsOf(values));
}

export async function selectPeople(client: TestClient) {
	return await client.select().from(schema.people);
}

export async function insertCollections(client: TestClient, values: Insertable<typeof schema.collections>): Promise<void> {
	await client.insert(schema.collections).values(rowsOf(values));
}

export async function selectCollections(client: TestClient) {
	return await client.select().from(schema.collections);
}

// Media files, markers, playback and watch state

export async function insertMediaFiles(client: TestClient, values: Insertable<typeof schema.mediaFiles>): Promise<Array<{ id: string }>> {
	return await client.insert(schema.mediaFiles).values(rowsOf(values)).returning({ id: schema.mediaFiles.id });
}

export async function selectMediaFiles(client: TestClient) {
	return await client.select().from(schema.mediaFiles);
}

export async function updateMediaFileDuration(client: TestClient, id: string, duration: number): Promise<void> {
	await client.update(schema.mediaFiles).set({ duration }).where(eq(schema.mediaFiles.id, id));
}

export async function insertMediaMarkers(client: TestClient, values: Insertable<typeof schema.mediaMarkers>): Promise<void> {
	await client.insert(schema.mediaMarkers).values(rowsOf(values));
}

export async function selectMediaMarkers(client: TestClient) {
	return await client.select().from(schema.mediaMarkers);
}

export async function insertPlaybackProgress(client: TestClient, values: Insertable<typeof schema.playbackProgress>): Promise<void> {
	await client.insert(schema.playbackProgress).values(rowsOf(values));
}

export async function selectPlaybackProgress(client: TestClient) {
	return await client.select().from(schema.playbackProgress);
}

export async function insertWatchlist(client: TestClient, values: Insertable<typeof schema.watchlist>): Promise<void> {
	await client.insert(schema.watchlist).values(rowsOf(values));
}

export async function selectWatchlist(client: TestClient) {
	return await client.select().from(schema.watchlist);
}

export async function insertWatchedHistory(client: TestClient, values: Insertable<typeof schema.watchedHistory>): Promise<void> {
	await client.insert(schema.watchedHistory).values(rowsOf(values));
}

export async function selectWatchedHistory(client: TestClient) {
	return await client.select().from(schema.watchedHistory);
}

export async function insertUserRatings(client: TestClient, values: Insertable<typeof schema.userRatings>): Promise<void> {
	await client.insert(schema.userRatings).values(rowsOf(values));
}
