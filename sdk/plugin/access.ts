export interface PluginAccessContext {
	userId: string;
	profileId?: string | undefined;
	resource: "stream";
	action: "play";
	mediaFileId?: string | undefined;
}

export interface PluginAccessDenial {
	allowed: false;
	code: string;
	message: string;
}

export interface PluginAccessPolicy {
	id: string;
	beforeAccess(context: Readonly<PluginAccessContext>): PluginAccessDenial | undefined | Promise<PluginAccessDenial | undefined>;
}

export interface PluginAccess {
	register(policy: PluginAccessPolicy): void;
}
