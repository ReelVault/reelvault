import { type Static, t } from "elysia";

export const TaskTriggerTypeSchema = t.Union([t.Literal("startup"), t.Literal("daily"), t.Literal("weekly"), t.Literal("interval")]);

export type TaskTriggerType = Static<typeof TaskTriggerTypeSchema>;

export const TaskTriggerSchema = t.Object({
	id: t.String(),
	type: TaskTriggerTypeSchema,
	timeOfDay: t.Optional(t.String()),
	dayOfWeek: t.Optional(t.Integer({ minimum: 0, maximum: 6 })),
	intervalMinutes: t.Optional(t.Integer({ minimum: 1 })),
	maxRuntimeMinutes: t.Optional(t.Integer({ minimum: 1 })),
});

export type TaskTrigger = Static<typeof TaskTriggerSchema>;

export const UpdateTaskTriggersRequestSchema = t.Object({
	triggers: t.Array(TaskTriggerSchema),
});

export type UpdateTaskTriggersRequest = Static<typeof UpdateTaskTriggersRequestSchema>;

export const ScheduledTaskCategorySchema = t.Union([t.Literal("library"), t.Literal("application"), t.Literal("plugins")]);

export type ScheduledTaskCategory = Static<typeof ScheduledTaskCategorySchema>;

export const TaskLastExecutionSchema = t.Object({
	startedAt: t.String({ format: "date-time" }),
	completedAt: t.Optional(t.String({ format: "date-time" })),
	durationMs: t.Optional(t.Integer({ minimum: 0 })),
	status: t.Union([t.Literal("completed"), t.Literal("failed"), t.Literal("cancelled")]),
	error: t.Optional(t.String()),
});

export type TaskLastExecution = Static<typeof TaskLastExecutionSchema>;
