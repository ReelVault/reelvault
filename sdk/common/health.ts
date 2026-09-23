import { t } from "elysia";

export const SubsystemStatusSchema = t.Object({
	name: t.String(),
	status: t.Union([t.Literal("healthy"), t.Literal("degraded"), t.Literal("unavailable")]),
	message: t.Optional(t.String()),
});

export type SubsystemStatus = typeof SubsystemStatusSchema.static;

export const HealthResponseSchema = t.Object({
	status: t.Union([t.Literal("ok"), t.Literal("degraded")]),
	timestamp: t.String({ format: "date-time" }),
	uptime: t.Number(),
	environment: t.String(),
	subsystems: t.Array(SubsystemStatusSchema),
	apiContractVersion: t.Optional(t.String()),
});

export type HealthStatus = typeof HealthResponseSchema.static;
