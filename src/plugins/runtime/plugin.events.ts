import { createPluginEventPayload, type PluginEventHandler, type PluginEventInput, type PluginEventName } from "@reelvault/sdk/plugin";
import { serverConfig } from "@/server.config";
import { systemResourcesService } from "@/system/system-resources.service";
import { BaseService } from "@/utils/base-service";
import { detach, PromiseUtils } from "@/utils/promise.utils";
import { PluginHandlerTable } from "./plugin-handler-table";

type ErasedPluginHandler = (payload: never) => void | Promise<void>;

export class PluginEventBus extends BaseService {
	private readonly handlersByEvent = new Map<PluginEventName, PluginHandlerTable<ErasedPluginHandler>>();
	private readonly timeoutMs: number;

	constructor(timeoutMs = serverConfig.plugins.runtime.hookTimeoutMs) {
		super("PluginEventBus");
		this.timeoutMs = timeoutMs;
	}

	on<TEvent extends PluginEventName>(pluginId: string, event: TEvent, handler: PluginEventHandler<TEvent>): () => void;
	on(pluginId: string, event: PluginEventName, handler: ErasedPluginHandler): () => void;
	on(pluginId: string, event: PluginEventName, handler: PluginEventHandler<PluginEventName> | ErasedPluginHandler): () => void {
		let handlers = this.handlersByEvent.get(event);
		if (!handlers) {
			handlers = new PluginHandlerTable<ErasedPluginHandler>();
			this.handlersByEvent.set(event, handlers);
		}
		handlers.register(pluginId, handler);

		return () => this.off(pluginId, event, handler);
	}

	off<TEvent extends PluginEventName>(pluginId: string, event: TEvent, handler: PluginEventHandler<TEvent>): void;
	off(pluginId: string, event: PluginEventName, handler: ErasedPluginHandler): void;
	off(pluginId: string, event: PluginEventName, handler: PluginEventHandler<PluginEventName> | ErasedPluginHandler): void {
		const handlers = this.handlersByEvent.get(event);
		if (!handlers) return;

		handlers.remove(pluginId, handler);
		if (handlers.size === 0) this.handlersByEvent.delete(event);
	}

	offPlugin(pluginId: string): void {
		for (const [event, handlers] of this.handlersByEvent) {
			handlers.offPlugin(pluginId);
			if (handlers.size === 0) this.handlersByEvent.delete(event);
		}
	}

	/** Fire-and-forget publish; failures are logged rather than surfaced to the caller. */
	publish<TEvent extends PluginEventName>(event: TEvent, payload: PluginEventInput<TEvent>): void {
		detach(this.emitLogged(event, payload));
	}

	private async emitLogged<TEvent extends PluginEventName>(event: TEvent, input: PluginEventInput<TEvent>): Promise<void> {
		try {
			await this.emit(event, input);
		} catch (error) {
			this.logger.error(`Plugin event bus failed to publish: ${event}`, error);
		}
	}

	async emit<TEvent extends PluginEventName>(event: TEvent, input: PluginEventInput<TEvent>): Promise<void> {
		const table = this.handlersByEvent.get(event);
		// No subscriber (the common case) — do not build the envelope for nobody.
		if (!table || table.size === 0) return;

		const payload = createPluginEventPayload(input);
		const handlers = table.all();
		// Time-box each handler: a hung plugin must not stall core event emission.
		const results = await PromiseUtils.mapConcurrent(handlers, systemResourcesService.getIoConcurrency(), async (handler) => {
			try {
				// ErasedPluginHandler accepts `never`, so dispatch goes through the
				// untyped apply channel and is re-boxed as unknown before awaiting.
				const run: unknown = Reflect.apply(handler, undefined, [payload]);
				await PromiseUtils.withTimeout(Promise.resolve(run), this.timeoutMs, `Plugin event ${event}`);

				return { status: "fulfilled" as const, value: undefined };
			} catch (reason) {
				return { status: "rejected" as const, reason };
			}
		});

		for (const result of results) {
			if (result.status === "rejected") this.logger.error(`Plugin event handler failed: ${event}`, result.reason);
		}
	}
}

export const pluginEventBus = new PluginEventBus();
