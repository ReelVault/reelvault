import { t } from "elysia";

/**
 * Live view of every child process the server has spawned (ffmpeg streaming and
 * background jobs, ffprobe probes, capability diagnostics). Feeds the admin
 * "background processes" panel — it is a point-in-time snapshot, not history.
 */
export const AdminProcessPurposeSchema = t.Union([
	t.Literal("streaming"),
	t.Literal("background"),
	t.Literal("probe"),
	t.Literal("diagnostic"),
]);

export type AdminProcessPurpose = typeof AdminProcessPurposeSchema.static;

export const AdminProcessSnapshotSchema = t.Object({
	pid: t.Nullable(t.Integer({ minimum: 1 })),
	purpose: AdminProcessPurposeSchema,
	label: t.Nullable(t.String()),
	startedAt: t.String({ format: "date-time" }),
	runtimeMs: t.Integer({ minimum: 0 }),
});

export const AdminProcessesResponseSchema = t.Object({
	counts: t.Object({
		streaming: t.Integer({ minimum: 0 }),
		background: t.Integer({ minimum: 0 }),
		probe: t.Integer({ minimum: 0 }),
		diagnostic: t.Integer({ minimum: 0 }),
		total: t.Integer({ minimum: 0 }),
	}),
	processes: t.Array(AdminProcessSnapshotSchema),
});

export type AdminProcessesResponse = typeof AdminProcessesResponseSchema.static;
