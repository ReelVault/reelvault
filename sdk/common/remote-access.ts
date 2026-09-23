import { t } from "elysia";

export const RemoteAccessCheckSchema = t.Object({
	id: t.String(),
	/** true = pass, false = action needed, null = informational warning. */
	ok: t.Union([t.Boolean(), t.Null()]),
	title: t.String(),
	detail: t.String(),
});

export type RemoteAccessCheck = typeof RemoteAccessCheckSchema.static;

export const RemoteAccessDiagnosticsSchema = t.Object({
	publicUrl: t.Nullable(t.String()),
	bindHost: t.String(),
	checks: t.Array(RemoteAccessCheckSchema),
	generated: t.Object({
		caddy: t.String(),
		nginx: t.String(),
		env: t.String(),
	}),
});

export type RemoteAccessDiagnostics = typeof RemoteAccessDiagnosticsSchema.static;
