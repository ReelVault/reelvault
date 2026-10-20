import { desc, eq } from "drizzle-orm";
import { type DatabaseFactory, databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { findOffsetPage } from "@/integrations/drizzle-orm/query/table-access/reads.reader";
import { DomainError } from "@/utils/domain.errors";

export type UpdateHistoryAction = "install" | "rollback";
export type UpdateHistoryTarget = "server" | "web";
export type UpdateHistoryStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface UpdateHistoryStart {
	action: UpdateHistoryAction;
	target: UpdateHistoryTarget;
	fromVersion: string | null;
	toVersion: string;
	actorUserId: string | null;
}

export interface UpdateHistoryOutcome {
	status: Exclude<UpdateHistoryStatus, "running">;
	errorMessage: string | null;
	finishedAt: Date;
}

export class UpdateHistoryRepository {
	readonly table = schema.updateHistory;
	private readonly database: Pick<DatabaseFactory, "getClient">;

	constructor(database: Pick<DatabaseFactory, "getClient"> = databaseFactory) {
		this.database = database;
	}

	/** Opens a run in the `running` state and returns its id. */
	async insert(run: UpdateHistoryStart, startedAt: Date): Promise<string> {
		const [row] = await this.database
			.getClient()
			.insert(this.table)
			.values({ ...run, status: "running", startedAt })
			.returning({ id: this.table.id });
		if (!row) throw new DomainError("internal", "The update history row was not written", { code: "update_history.row_missing" });

		return row.id;
	}

	async finish(id: string, outcome: UpdateHistoryOutcome): Promise<void> {
		await this.database.getClient().update(this.table).set(outcome).where(eq(this.table.id, id));
	}

	async findRunning() {
		return await this.database.getClient().select().from(this.table).where(eq(this.table.status, "running"));
	}

	/** Newest runs first; the total counts every run, not just the page. */
	async findPage({ limit, offset }: { limit: number; offset: number }) {
		return await findOffsetPage({
			access: { tableName: "update_history", primaryKeyColumn: this.table.id },
			orderBy: desc(this.table.startedAt),
			limit,
			offset,
			findMany: async (page) =>
				await this.database
					.getClient()
					.select()
					.from(this.table)
					.where(page.where)
					.orderBy(page.orderBy)
					.limit(page.limit)
					.offset(page.offset),
			count: () => this.database.getClient().$count(this.table),
		});
	}
}

export const updateHistoryRepository = new UpdateHistoryRepository();
