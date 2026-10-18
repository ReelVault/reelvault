/**
 * A named group of per-plugin handlers of one kind (one hook type, or one event
 * type on the event bus). Plugins own sets of handlers so unregistering a
 * plugin can drop all of its handlers at once; iteration order is plugin
 * insertion order, then handler registration order within a plugin.
 */
export class PluginHandlerTable<THandler> {
	private readonly handlersByPlugin = new Map<string, Set<THandler>>();

	get size(): number {
		return this.handlersByPlugin.size;
	}

	register(pluginId: string, handler: THandler): () => void {
		const handlers = this.handlersByPlugin.get(pluginId) ?? new Set<THandler>();
		handlers.add(handler);
		this.handlersByPlugin.set(pluginId, handlers);

		return () => this.remove(pluginId, handler);
	}

	remove(pluginId: string, handler: THandler): void {
		const handlers = this.handlersByPlugin.get(pluginId);
		if (!handlers) return;

		handlers.delete(handler);
		if (handlers.size === 0) this.handlersByPlugin.delete(pluginId);
	}

	offPlugin(pluginId: string): void {
		this.handlersByPlugin.delete(pluginId);
	}

	all(): THandler[] {
		return [...this.handlersByPlugin.values()].flatMap((set) => [...set]);
	}
}
