import { desc, eq } from "drizzle-orm";
import { type DatabaseFactory, databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";

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
		if (!row) throw new Error("The update history row was not written");

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
		const client = this.database.getClient();
		const [total, data] = await Promise.all([
			client.$count(this.table),
			client.select().from(this.table).orderBy(desc(this.table.startedAt), desc(this.table.id)).limit(limit).offset(offset),
		]);

		return { total, data };
	}
}

export const updateHistoryRepository = new UpdateHistoryRepository();
