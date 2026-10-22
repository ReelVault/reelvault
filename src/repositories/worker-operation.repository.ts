import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import type { TerminalRowsPurgeOptions } from "@/repositories/worker-jobs/shared.types";
import { createOperation, markResumed, removeOperation, requestCancel } from "./worker-operation/lifecycle.writer";
import {
	incrementTotalItems,
	markJobFinished,
	markJobRetried,
	markJobStarted,
	markPendingJobsCancelled,
	reconcileFromJobs,
	updateProgress,
} from "./worker-operation/progress.writer";
import {
	findActiveLibraryScans,
	findActiveOperationByReference,
	findLatestLibraryScanTimes,
	findOperationById,
	getOperationItemsSummary,
	listOperationItems,
	listOperations,
	type OperationItemsOptions,
	type OperationListOptions,
} from "./worker-operation/reads.reader";
import {
	cleanupExpiredOperations,
	countTerminalOperations,
	finalizeTerminalOperations,
	purgeTerminalOperations,
} from "./worker-operation/retention.writer";
import type { CreateWorkerOperationInput } from "./worker-operation/shared.types";
import { completeStreamSlot, markStreamAttached, releaseStreamSlot } from "./worker-operation/streams.writer";

export const workerOperationRepository = {
	create(input: CreateWorkerOperationInput) {
		return createOperation(input);
	},

	findById(id: string) {
		return findOperationById(id);
	},

	/** Newest non-terminal operation of a type attached to a reference — used to join an in-flight batch. */
	findActiveByReference(type: string, referenceType: string, referenceId: string) {
		return findActiveOperationByReference(type, referenceType, referenceId);
	},

	/** Latest library-scan operation time per library; see {@link findLatestLibraryScanTimes}. */
	findLatestLibraryScanTimes(libraryIds: readonly string[]) {
		return findLatestLibraryScanTimes(libraryIds);
	},

	findActiveLibraryScans() {
		return findActiveLibraryScans();
	},

	list(options: OperationListOptions = {}) {
		return listOperations(options);
	},

	listItems(operationId: string, options: OperationItemsOptions = {}) {
		return listOperationItems(operationId, options);
	},

	getOperationItemsSummary(operationId: string) {
		return getOperationItemsSummary(operationId);
	},

	incrementTotalItems(operationId: string, amount: number, tx?: DatabaseTransaction) {
		return incrementTotalItems(operationId, amount, tx);
	},

	updateProgress(operationId: string, progressPercent: number, tx?: DatabaseTransaction) {
		return updateProgress(operationId, progressPercent, tx);
	},

	markJobStarted(operationId: string, now: Date = new Date(), tx?: DatabaseTransaction, amount = 1) {
		return markJobStarted(operationId, now, tx, amount);
	},

	/** Keeps a streaming-session operation alive while its ffmpeg process runs; see {@link markStreamAttached}. */
	markStreamAttached(operationId: string) {
		return markStreamAttached(operationId);
	},

	/** Releases the streaming slot counter — the reaper calls this on session teardown. */
	releaseStreamSlot(operationId: string) {
		return releaseStreamSlot(operationId);
	},

	/** Closes the slot after a natural ffmpeg EOF; see {@link completeStreamSlot}. */
	completeStreamSlot(operationId: string) {
		return completeStreamSlot(operationId);
	},

	markJobRetried(operationId: string, now: Date = new Date(), tx?: DatabaseTransaction, amount = 1) {
		return markJobRetried(operationId, now, tx, amount);
	},

	markJobFinished(
		operationId: string,
		jobStatus: "completed" | "failed" | "cancelled",
		now: Date = new Date(),
		tx?: DatabaseTransaction,
		amount = 1,
	) {
		return markJobFinished(operationId, jobStatus, now, tx, amount);
	},

	/** Cancels pending (not running) jobs; see {@link markPendingJobsCancelled}. */
	markPendingJobsCancelled(operationId: string, now: Date = new Date(), tx?: DatabaseTransaction, amount = 1) {
		return markPendingJobsCancelled(operationId, now, tx, amount);
	},

	/** Admin resume: clear the cancel request and re-arm the operation for its re-enqueued jobs. */
	markResumed(id: string, totalItems = 0) {
		return markResumed(id, totalItems);
	},

	reconcileFromJobs(operationId: string) {
		return reconcileFromJobs(operationId);
	},

	requestCancel(id: string) {
		return requestCancel(id);
	},

	remove(id: string) {
		return removeOperation(id);
	},

	finalizeTerminalOperations(now: Date = new Date(), retentionDays = 7) {
		return finalizeTerminalOperations(now, retentionDays);
	},

	cleanupExpired(now: Date = new Date()) {
		return cleanupExpiredOperations(now);
	},

	purgeTerminalOperations(options: TerminalRowsPurgeOptions = {}) {
		return purgeTerminalOperations(options);
	},

	/** What `purgeTerminalOperations` would delete with the same filters. */
	countTerminalOperations(options: TerminalRowsPurgeOptions = {}) {
		return countTerminalOperations(options);
	},
};
