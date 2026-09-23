import type {
	CreateMediaMarker,
	MediaMarker,
	MetadataCandidate,
	MetadataItem,
	PlaybackArtifact,
	PlaybackArtifactWrite,
	PluginMediaFile,
} from "../common";
import type { Logger } from "../common/logger";
import type { PluginAccessContext, PluginAccessDenial, PluginAccessPolicy } from "../plugin/access";
import { createPluginEventPayload, type PluginEventHandler, type PluginEventInput, type PluginEventName } from "../plugin/events";
import type {
	ArtifactCreationCandidate,
	BeforeArtifactCreateHook,
	BeforeMediaRecognitionHook,
	BeforeMetadataSaveHook,
	MediaRecognitionCandidate,
} from "../plugin/hooks";
import type { PluginHttpRoute } from "../plugin/http";
import type { PluginNotification } from "../plugin/notifications";
import type { PluginBlob, PluginBlobMetadata, PluginBlobWriteOptions } from "../plugin/storage";
import type {
	ExtractedFrame,
	ExtractedSprite,
	FrameExtractionRequest,
	MediaAnalyzer,
	MetadataAvailability,
	MetadataProvider,
	PluginEnqueueOptions,
	PluginEpisodeMediaFile,
	PluginHost,
	PluginJobDefinition,
	PluginJobHandle,
	PluginMediaFileInfo,
	PluginScheduledTaskDefinition,
	ProviderDiscoveryRequest,
	ProviderDiscoveryResult,
	ProviderMediaType,
	ProviderMetadataResult,
	ProviderResultGenre,
	ProviderSearchRequest,
	ProviderSearchResponse,
	ProviderSeasonResult,
	ProviderStatus,
	SpriteExtractionRequest,
	SubtitleProvider,
} from "../plugin/types";

export interface EnqueuedPluginJob {
	name: string;
	data: unknown;
	options?: PluginEnqueueOptions | undefined;
}

/** Discards all output; the test host logger must never emit logs. */
function noop(): void {
	// Intentionally silent.
}

export class PluginTestHost implements PluginHost {
	readonly logger: Logger = createTestLogger();
	readonly config: Readonly<Record<string, unknown>> = {};
	readonly http = {
		fetch: (): Promise<Response> => Promise.resolve(new Response("")),
	};
	readonly registeredProviders: MetadataProvider[] = [];
	readonly registeredSubtitleProviders: SubtitleProvider[] = [];
	readonly registeredMediaAnalyzers: MediaAnalyzer[] = [];
	readonly registeredJobs: PluginJobDefinition[] = [];
	readonly registeredRoutes: PluginHttpRoute[] = [];
	readonly registeredAccessPolicies: PluginAccessPolicy[] = [];
	readonly createdNotifications: PluginNotification[] = [];
	readonly enqueuedJobs: EnqueuedPluginJob[] = [];
	private readonly mediaFiles = new Map<string, PluginMediaFile>();
	private readonly metadataItems = new Map<string, MetadataItem>();
	private readonly storedValues = new Map<string, unknown>();
	private readonly storedBlobs = new Map<string, { metadata: PluginBlobMetadata; content: Uint8Array }>();
	private readonly storedArtifacts = new Map<string, PlaybackArtifact[]>();
	private readonly artifactContents = new Map<string, Uint8Array>();
	private readonly storedMarkers = new Map<string, MediaMarker[]>();

	private readonly eventHandlers = new Map<PluginEventName, Array<(payload: never) => void | Promise<void>>>();
	private readonly beforeArtifactCreateHooks: BeforeArtifactCreateHook[] = [];
	private readonly beforeMediaRecognitionHooks: BeforeMediaRecognitionHook[] = [];
	private readonly beforeMetadataSaveHooks: BeforeMetadataSaveHook[] = [];

	readonly providers = {
		register: (provider: MetadataProvider): Promise<void> => {
			this.registeredProviders.push(provider);

			return Promise.resolve();
		},
		list: (): Promise<ProviderStatus[]> =>
			Promise.resolve(
				this.registeredProviders.map((provider) => ({
					id: provider.id,
					name: provider.name,
					version: provider.version,
					pluginId: "test-plugin",
				})),
			),
		search: (_request: ProviderSearchRequest): Promise<ProviderSearchResponse[]> => Promise.resolve([]),
		getDetails: (_providerId: string, _type: ProviderMediaType, _externalId: string): Promise<ProviderMetadataResult | null> =>
			Promise.resolve(null),
		getSeasonDetails: (_providerId: string, _externalId: string, _seasonNumber: number): Promise<ProviderSeasonResult | null> =>
			Promise.resolve(null),
		resolveDetails: (_type: ProviderMediaType, _title: string, _year?: number): Promise<ProviderMetadataResult | null> =>
			Promise.resolve(null),
		discover: (_request: ProviderDiscoveryRequest): Promise<ProviderDiscoveryResult | null> => Promise.resolve(null),
		getGenres: (_type: ProviderMediaType, _providerId?: string): Promise<ProviderResultGenre[]> => Promise.resolve([]),
	};

	readonly subtitles = {
		register: (provider: SubtitleProvider): Promise<void> => {
			this.registeredSubtitleProviders.push(provider);

			return Promise.resolve();
		},
	};

	readonly media = {
		get: (mediaFileId: string): Promise<PluginMediaFile | null> => Promise.resolve(this.mediaFiles.get(mediaFileId) ?? null),
		getRevision: (): Promise<null> => Promise.resolve(null),
		listEpisodeFilesBySeason: (): Promise<Map<string, PluginEpisodeMediaFile[]>> =>
			Promise.resolve(new Map<string, PluginEpisodeMediaFile[]>()),
		listAllMediaFiles: (): Promise<PluginMediaFileInfo[]> => Promise.resolve([]),
		registerAnalyzer: (analyzer: MediaAnalyzer): Promise<void> => {
			this.registeredMediaAnalyzers.push(analyzer);

			return Promise.resolve();
		},
	};

	readonly metadata = {
		get: (metadataId: string): Promise<MetadataItem | null> => Promise.resolve(this.metadataItems.get(metadataId) ?? null),
		findByExternalId: (providerId: string, externalId: string, type: ProviderMediaType): Promise<MetadataAvailability | null> =>
			Promise.resolve(this.findAvailability(providerId, externalId, type)),
		findManyByExternalIds: (providerId: string, externalIds: readonly string[], type: ProviderMediaType): Promise<MetadataAvailability[]> =>
			Promise.resolve(
				externalIds
					.map((externalId) => this.findAvailability(providerId, externalId, type))
					.filter((availability): availability is MetadataAvailability => availability !== null),
			),
	};

	readonly artifacts = {
		list: (mediaFileId: string): Promise<PlaybackArtifact[]> => Promise.resolve([...(this.storedArtifacts.get(mediaFileId) ?? [])]),
		write: async (artifact: PlaybackArtifactWrite): Promise<PlaybackArtifact> => {
			const candidate = await this.runBeforeArtifactCreate({
				mediaFileId: artifact.mediaFileId,
				kind: artifact.kind,
				contentType: artifact.contentType,
				size: artifact.content instanceof Blob ? artifact.content.size : artifact.content.byteLength,
			});
			const content =
				artifact.content instanceof Blob ? new Uint8Array(await artifact.content.arrayBuffer()) : new Uint8Array(artifact.content);
			const storedArtifact: PlaybackArtifact = {
				id: crypto.randomUUID(),
				mediaFileId: candidate.mediaFileId,
				pluginId: "test-plugin",
				kind: candidate.kind,
				url: `/v1/media-files/${candidate.mediaFileId}/artifacts/test`,
				contentType: candidate.contentType,
				createdAt: new Date().toISOString(),
			};
			this.artifactContents.set(storedArtifact.id, content);
			const mediaArtifacts = this.storedArtifacts.get(candidate.mediaFileId) ?? [];
			mediaArtifacts.push(storedArtifact);
			this.storedArtifacts.set(candidate.mediaFileId, mediaArtifacts);

			return storedArtifact;
		},
	};

	readonly ffmpeg = {
		runAnalyse: (): Promise<{ exitCode: number; stderr: string }> => Promise.resolve({ exitCode: 0, stderr: "" }),
		extractFrame: (request: FrameExtractionRequest): Promise<ExtractedFrame> =>
			Promise.resolve({
				content: new Uint8Array([0]),
				contentType: request.format === "jpeg" ? "image/jpeg" : "image/webp",
			}),
		extractSprite: (request: SpriteExtractionRequest): Promise<ExtractedSprite> =>
			Promise.resolve({
				content: new Uint8Array([0]),
				contentType: request.format === "jpeg" ? "image/jpeg" : "image/webp",
				frameWidth: request.width,
				frameHeight: request.height,
				columns: request.columns,
				rows: Math.ceil(request.timeMs.length / request.columns),
			}),
	};

	readonly jobs = {
		register: <TData = unknown, TResult = unknown>(definition: PluginJobDefinition<TData, TResult>): Promise<void> => {
			this.registeredJobs.push(definition);

			return Promise.resolve();
		},
		enqueue: (name: string, data: unknown, options?: PluginEnqueueOptions): Promise<PluginJobHandle> => {
			this.enqueuedJobs.push({ name, data, options });

			return Promise.resolve({ id: crypto.randomUUID(), name, operationId: options?.operationId });
		},
		enqueueMany: (
			name: string,
			items: Array<{ data: unknown; options?: PluginEnqueueOptions }>,
			commonOptions?: { operationId?: string; reference?: { type: string; id: string } },
		): Promise<PluginJobHandle[]> => {
			const handles: PluginJobHandle[] = [];
			const opId = commonOptions?.operationId ?? crypto.randomUUID();
			for (const item of items) {
				const opts = { ...item.options, operationId: item.options?.operationId ?? opId };
				this.enqueuedJobs.push({ name, data: item.data, options: opts });
				handles.push({ id: crypto.randomUUID(), name, operationId: opId });
			}

			return Promise.resolve(handles);
		},
	};

	readonly tasks = {
		register: (_task: PluginScheduledTaskDefinition): Promise<void> => {
			// intentionally empty
			return Promise.resolve();
		},
	};

	readonly routes = {
		register: (route: PluginHttpRoute): Promise<void> => {
			this.registeredRoutes.push(route);

			return Promise.resolve();
		},
	};

	readonly access = {
		register: (policy: PluginAccessPolicy): void => {
			this.registeredAccessPolicies.push(policy);
		},
	};

	readonly notifications = {
		create: (notification: PluginNotification): Promise<void> => {
			this.createdNotifications.push(structuredClone(notification));

			return Promise.resolve();
		},
	};

	readonly realtime = {
		broadcast: (_type: string, _payload: unknown): void => {
			// intentionally empty
		},
		sendToUser: (_userId: string, _type: string, _payload: unknown): void => {
			// intentionally empty
		},
		sendToProfile: (_profileId: string, _type: string, _payload: unknown): void => {
			// intentionally empty
		},
		sendToSession: (_sessionId: string, _type: string, _payload: unknown): void => {
			// intentionally empty
		},
	};

	readonly storage = {
		get: (key: string): Promise<unknown> => {
			const value = this.storedValues.get(key);

			return Promise.resolve(value === undefined ? undefined : structuredClone(value));
		},
		set: (key: string, value: unknown): Promise<void> => {
			this.storedValues.set(key, structuredClone(value));

			return Promise.resolve();
		},
		update: (key: string, updater: (current: unknown) => unknown): Promise<unknown> => {
			const current = this.storedValues.get(key);
			const next = updater(current === undefined ? undefined : structuredClone(current));
			if (next instanceof Promise) {
				return next.then((resolved: unknown) => {
					this.storedValues.set(key, structuredClone(resolved));

					return resolved;
				});
			}

			this.storedValues.set(key, structuredClone(next));

			return Promise.resolve(next);
		},
		delete: (key: string): Promise<void> => {
			this.storedValues.delete(key);

			return Promise.resolve();
		},
		list: (prefix?: string): Promise<string[]> =>
			Promise.resolve([...this.storedValues.keys()].filter((key) => !prefix || key.startsWith(prefix)).toSorted()),
		putBlob: async (key: string, content: Blob | Uint8Array, options: PluginBlobWriteOptions): Promise<PluginBlobMetadata> => {
			const bytes = content instanceof Blob ? new Uint8Array(await content.arrayBuffer()) : new Uint8Array(content);
			const createdAt = new Date();
			const metadata: PluginBlobMetadata = {
				key,
				contentType: options.contentType,
				size: bytes.byteLength,
				createdAt: createdAt.toISOString(),
				expiresAt: new Date(createdAt.getTime() + options.expiresInMs).toISOString(),
			};
			this.storedBlobs.set(key, { metadata, content: bytes });

			return metadata;
		},
		getBlob: (key: string): Promise<PluginBlob | undefined> => {
			const blob = this.readLiveBlob(key);

			return Promise.resolve(blob);
		},
		deleteBlob: (key: string): Promise<void> => {
			this.storedBlobs.delete(key);

			return Promise.resolve();
		},
	};

	readonly markers = {
		list: (mediaFileId: string): Promise<MediaMarker[]> => Promise.resolve(structuredClone(this.storedMarkers.get(mediaFileId) ?? [])),
		set: (mediaFileId: string, markers: readonly CreateMediaMarker[]): Promise<MediaMarker[]> => {
			const saved: MediaMarker[] = markers.map((m, idx) => ({
				id: `test_marker_${idx}`,
				mediaFileId,
				type: m.type,
				startSeconds: m.startSeconds,
				endSeconds: m.endSeconds,
				label: m.label ?? null,
				source: m.source ?? "plugin",
				pluginId: m.pluginId ?? null,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			}));
			this.storedMarkers.set(mediaFileId, saved);

			return Promise.resolve(structuredClone(saved));
		},
		clear: (mediaFileId: string): Promise<void> => {
			this.storedMarkers.delete(mediaFileId);

			return Promise.resolve();
		},
	};

	readonly events = {
		on: <TEvent extends PluginEventName>(event: TEvent, handler: PluginEventHandler<TEvent>): void => {
			const handlers = this.eventHandlers.get(event) ?? [];
			handlers.push(handler);
			this.eventHandlers.set(event, handlers);
		},
	};

	readonly hooks = {
		beforeArtifactCreate: (handler: BeforeArtifactCreateHook): void => {
			this.beforeArtifactCreateHooks.push(handler);
		},
		beforeMediaRecognition: (handler: BeforeMediaRecognitionHook): void => {
			this.beforeMediaRecognitionHooks.push(handler);
		},
		beforeMetadataSave: (handler: BeforeMetadataSaveHook): void => {
			this.beforeMetadataSaveHooks.push(handler);
		},
	};

	constructor(config: Readonly<Record<string, unknown>> = {}) {
		this.config = config;
	}

	async emit<TEvent extends PluginEventName>(event: TEvent, input: PluginEventInput<TEvent>): Promise<void> {
		const payload = createPluginEventPayload(input);
		const handlers = this.eventHandlers.get(event) ?? [];
		await Promise.all(
			handlers.map(async (handler) => {
				// Handlers are stored contravariantly (payload: never), so the concrete
				// payload is applied dynamically; rejections still propagate.
				await Reflect.apply(handler, undefined, [payload]);
			}),
		);
	}

	setMediaFile(mediaFile: PluginMediaFile): void {
		this.mediaFiles.set(mediaFile.id, mediaFile);
	}

	setMetadataItem(metadata: MetadataItem): void {
		this.metadataItems.set(metadata.id, metadata);
	}

	private findAvailability(providerId: string, externalId: string, type: ProviderMediaType): MetadataAvailability | null {
		for (const metadata of this.metadataItems.values()) {
			if (metadata.type !== type) continue;

			const matches = metadata.externalIds.some(
				(identity) => identity.providerId === providerId && identity.entityType === type && identity.externalId === externalId,
			);
			if (!matches) continue;

			const fileCount = [...this.mediaFiles.values()].filter((file) => file.metadataId === metadata.id).length;

			return { externalId, metadataId: metadata.id, title: metadata.title, type, hasFiles: fileCount > 0, fileCount };
		}

		return null;
	}

	getArtifactContent(artifactId: string): Uint8Array | undefined {
		const content = this.artifactContents.get(artifactId);

		return content ? new Uint8Array(content) : undefined;
	}

	private readLiveBlob(key: string): PluginBlob | undefined {
		const stored = this.storedBlobs.get(key);
		if (!stored || new Date(stored.metadata.expiresAt) <= new Date()) {
			this.storedBlobs.delete(key);

			return undefined;
		}

		const content = new Uint8Array(stored.content.byteLength);
		content.set(stored.content);

		return { ...stored.metadata, content: new Blob([content], { type: stored.metadata.contentType }) };
	}

	async runBeforeMetadataSave(candidate: MetadataCandidate): Promise<MetadataCandidate> {
		let transformed = candidate;
		for (const hook of this.beforeMetadataSaveHooks) {
			const result = await hook({ candidate: structuredClone(transformed) });
			if (result) transformed = result;
		}

		return transformed;
	}

	async runBeforeMediaRecognition(candidate: MediaRecognitionCandidate): Promise<MediaRecognitionCandidate> {
		let transformed = candidate;
		for (const hook of this.beforeMediaRecognitionHooks) {
			const result = await hook({ candidate: structuredClone(transformed) });
			if (result) transformed = result;
		}

		return transformed;
	}

	async runBeforeArtifactCreate(candidate: ArtifactCreationCandidate): Promise<ArtifactCreationCandidate> {
		let transformed = candidate;
		for (const hook of this.beforeArtifactCreateHooks) {
			const result = await hook({ candidate: structuredClone(transformed) });
			if (result) transformed = result;
		}

		return transformed;
	}

	async checkAccess(context: PluginAccessContext): Promise<PluginAccessDenial | undefined> {
		for (const policy of this.registeredAccessPolicies) {
			const decision = await policy.beforeAccess(context);
			if (decision) return decision;
		}

		return undefined;
	}
}

export function createPluginTestHost(config: Readonly<Record<string, unknown>> = {}): PluginTestHost {
	return new PluginTestHost(config);
}

export function createTestLogger(): Logger {
	const logger: Logger = {
		trace: noop,
		debug: noop,
		info: noop,
		warn: noop,
		error: noop,
		fatal: noop,
		child: () => logger,
		time: () => noop,
	};

	return logger;
}
