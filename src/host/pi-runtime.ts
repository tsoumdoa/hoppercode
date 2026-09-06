import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthType } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionServicesOptions,
	ModelRuntime,
	SessionManager,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import hopperPiExtension, { createHopperPiExtension, type HopperExtensionOptions } from "../index.js";
import hopperChoicesExtension from "../extensions/choices/index.js";
import { serializeAgentEvent, toWireValue } from "./event-serializer.js";
import { HostMessageBus } from "./message-bus.js";
import type { HostPaths } from "./config.js";
import type { ImageAttachment, HostSnapshot, SkillLibrarySnapshot, SkillLibraryUpdate } from "./protocol.js";
import { HostSkillLibrary } from "./skills.js";
import { BrowserUiContext } from "./web-ui-context.js";

export type EmbeddedPiHostOptions = {
	paths: HostPaths;
	projectRoot?: string;
	bus?: HostMessageBus;
	onShutdownRequest?: () => void;
};

function defaultProjectRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

function modelSummary(model: { provider: string; id: string; name?: string; input?: string[] }) {
	return { provider: model.provider, id: model.id, name: model.name, input: model.input };
}

export function providerAuthMethods(auth: {
	apiKey?: { name: string; login?: unknown };
	oauth?: { name: string; loginLabel?: string };
}): HostSnapshot["providers"][number]["authMethods"] {
	return [
		...(auth.apiKey?.login ? [{ type: "api_key" as const, label: auth.apiKey.name }] : []),
		...(auth.oauth ? [{ type: "oauth" as const, label: auth.oauth.loginLabel ?? auth.oauth.name }] : []),
	];
}

export function isolatedResourceLoaderOptions(scriptOptions?: HopperExtensionOptions): NonNullable<CreateAgentSessionServicesOptions["resourceLoaderOptions"]> {
	return {
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			{ name: "hopper", factory: scriptOptions ? createHopperPiExtension(scriptOptions) : hopperPiExtension },
			{ name: "hopper-choices", factory: hopperChoicesExtension },
		],
	};
}

export class EmbeddedPiHost {
	readonly bus: HostMessageBus;
	readonly ui: BrowserUiContext;
	private unsubscribe?: () => void;
	private disposed = false;
	private skillUpdate?: Promise<void>;
	private promptPending = false;
	private promptGeneration = 0;

	private constructor(
		private readonly runtime: AgentSessionRuntime,
		bus: HostMessageBus,
		ui: BrowserUiContext,
		private readonly skills: HostSkillLibrary,
		private readonly onShutdownRequest?: () => void,
	) {
		this.bus = bus;
		this.ui = ui;
	}

	static async create(options: EmbeddedPiHostOptions): Promise<EmbeddedPiHost> {
		const projectRoot = options.projectRoot ?? defaultProjectRoot();
		const { paths } = options;
		await Promise.all([
			mkdir(paths.agentDir, { recursive: true }),
			mkdir(paths.sessionsDir, { recursive: true }),
			mkdir(paths.workspaceDir, { recursive: true }),
		]);

		const bus = options.bus ?? new HostMessageBus();
		const ui = new BrowserUiContext(bus);
		const skills = new HostSkillLibrary(
			projectRoot, join(paths.dataDir, "skills-settings.json"), join(paths.dataDir, "skills"),
		);
		await skills.initialize();
		const modelRuntime = await ModelRuntime.create({
			authPath: paths.authPath,
			modelsPath: join(paths.agentDir, "models.json"),
			modelsStorePath: join(paths.agentDir, "models-store.json"),
		});

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: paths.agentDir,
				modelRuntime,
				resourceLoaderOptions: isolatedResourceLoaderOptions({
					scriptWorkspaceDir: paths.scriptWorkspaceDir ?? join(paths.dataDir, "workspaces", "default"),
					scriptWorkspaceQuotaBytes: paths.scriptWorkspaceQuotaBytes,
					sessionId: () => sessionManager.getSessionId(),
				}),
			});
			// Keep skill discovery live without reloading extensions or changing active tools.
			services.resourceLoader.getSkills = () => skills.getSkills();
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					noTools: "builtin",
					customTools: [skills.createReadTool(cwd)],
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: paths.workspaceDir,
			agentDir: paths.agentDir,
			sessionManager: SessionManager.continueRecent(paths.workspaceDir, paths.sessionsDir),
		});
		const host = new EmbeddedPiHost(runtime, bus, ui, skills, options.onShutdownRequest);
		runtime.setRebindSession(async (session) => host.bindSession(session, true));
		await host.bindSession(runtime.session, false);
		return host;
	}

	async prompt(text: string, images?: ImageAttachment[], onAccepted?: () => void): Promise<void> {
		this.assertUsable();
		if (!this.runtime.session.model) throw new Error("No authenticated model is selected");
		if (this.promptPending) throw new Error("Hopper is already processing a prompt");
		this.promptPending = true;
		const generation = this.promptGeneration;
		try {
			await this.refreshSkills(true);
			this.assertUsable();
			if (generation !== this.promptGeneration) throw new Error("Prompt cancelled before it started");
			this.assertImageSupport(images);
			await this.runtime.session.prompt(this.skills.expandCommand(text), {
				source: "rpc", images,
				...(onAccepted ? { preflightResult: (success: boolean) => { if (success) onAccepted(); } } : {}),
			});
		} finally { this.promptPending = false; }
	}

	async listSkills() {
		this.assertUsable();
		await this.refreshSkills();
		return this.skills.snapshot();
	}

	readSkill(path: string): string {
		this.assertUsable();
		return this.skills.read(path, false);
	}

	async updateSkills(update: SkillLibraryUpdate): Promise<SkillLibrarySnapshot> {
		this.assertUsable();
		while (this.skillUpdate) await this.skillUpdate;
		if (this.promptPending || this.runtime.session.isStreaming || this.runtime.session.isCompacting) {
			throw new Error("Wait until Hopper finishes before changing skills.");
		}
		this.skillUpdate = this.skills.update(update);
		try {
			await this.skillUpdate;
			this.rebuildSkillPrompt();
			return this.skills.snapshot();
		} finally { this.skillUpdate = undefined; }
	}

	private async refreshSkills(forPrompt = false): Promise<void> {
		while (this.skillUpdate) await this.skillUpdate;
		if ((!forPrompt && this.promptPending) || this.runtime.session.isStreaming || this.runtime.session.isCompacting) return;
		this.skillUpdate = this.skills.refresh();
		try {
			await this.skillUpdate;
			this.rebuildSkillPrompt();
		} finally { this.skillUpdate = undefined; }
	}

	private rebuildSkillPrompt(): void {
		this.runtime.session.setActiveToolsByName(this.runtime.session.getActiveToolNames());
	}

	private assertImageSupport(images?: ImageAttachment[]): void {
		if (images?.length && !this.runtime.session.model?.input?.includes("image")) {
			throw new Error("Select a model that supports images before sending attachments.");
		}
	}

	async steer(text: string, images?: ImageAttachment[]): Promise<void> {
		this.assertUsable();
		while (this.skillUpdate) await this.skillUpdate;
		this.assertImageSupport(images);
		await this.runtime.session.steer(this.skills.expandCommand(text), images);
	}

	async followUp(text: string, images?: ImageAttachment[]): Promise<void> {
		this.assertUsable();
		while (this.skillUpdate) await this.skillUpdate;
		this.assertImageSupport(images);
		await this.runtime.session.followUp(this.skills.expandCommand(text), images);
	}

	async abort(): Promise<void> {
		this.assertUsable();
		this.promptGeneration++;
		await this.runtime.session.abort();
	}

	async newSession(): Promise<void> {
		this.assertUsable();
		this.promptGeneration++;
		while (this.skillUpdate) await this.skillUpdate;
		await this.runtime.newSession();
	}

	async setModel(provider: string, id: string): Promise<void> {
		this.assertUsable();
		const model = this.runtime.services.modelRuntime.getModel(provider, id);
		if (!model) throw new Error(`Unknown model: ${provider}/${id}`);
		if (!this.runtime.services.modelRuntime.hasConfiguredAuth(provider)) {
			throw new Error(`Provider is not authenticated: ${provider}`);
		}
		await this.runtime.session.setModel(model, { persist: true });
		const settings = this.runtime.services.settingsManager;
		await settings.flush();
		const errors = settings.drainErrors();
		this.publishSnapshot();
		if (errors.length) {
			throw new Error(`Model selected, but settings could not be saved: ${errors.map(({ error }) => error.message).join("; ")}`);
		}
	}

	setThinkingLevel(level: string): void {
		this.assertUsable();
		const selected = this.runtime.session.getAvailableThinkingLevels().find((candidate) => candidate === level);
		if (!selected) throw new Error(`Thinking level is unavailable: ${level}`);
		this.runtime.session.setThinkingLevel(selected, { persist: true });
		this.publishSnapshot();
	}

	async login(provider: string, authType: AuthType, apiKey?: string): Promise<void> {
		this.assertUsable();
		let suppliedApiKey = apiKey;
		await this.runtime.services.modelRuntime.login(provider, authType, {
			prompt: (prompt) => {
				if (prompt.type === "secret" && suppliedApiKey) {
					const value = suppliedApiKey;
					suppliedApiKey = undefined;
					return Promise.resolve(value);
				}
				return this.ui.requestAuthPrompt(prompt);
			},
			notify: (event) => this.ui.notifyAuth(event),
		});
		this.bus.publish({ type: "status", status: "authenticated", scope: "auth", provider });
		this.publishSnapshot();
	}

	async logout(provider: string): Promise<void> {
		this.assertUsable();
		await this.runtime.services.modelRuntime.logout(provider);
		this.bus.publish({ type: "status", status: "logged_out", scope: "auth", provider });
		this.publishSnapshot();
	}

	snapshot(): HostSnapshot {
		const session = this.runtime.session;
		const messages = toWireValue(session.messages);
		return {
			sessionId: session.sessionId,
			sessionFile: session.sessionFile,
			sessionName: session.sessionName,
			messages: Array.isArray(messages) ? messages : [],
			streamingMessage: session.agent.state.streamingMessage
				? toWireValue(session.agent.state.streamingMessage) : undefined,
			isStreaming: session.isStreaming,
			model: session.model ? modelSummary(session.model) : undefined,
			thinkingLevel: session.thinkingLevel,
			availableThinkingLevels: session.getAvailableThinkingLevels(),
			models: this.runtime.services.modelRuntime.getAvailableSnapshot().map(modelSummary),
			providers: this.runtime.services.modelRuntime.getProviders().map((provider) => ({
				id: provider.id,
				name: provider.name,
				authenticated: this.runtime.services.modelRuntime.hasConfiguredAuth(provider.id),
				authMethods: providerAuthMethods(provider.auth),
			})),
		};
	}

	publishSnapshot(): void {
		this.bus.publish({ type: "snapshot", snapshot: this.snapshot() });
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		if (this.skillUpdate) await this.skillUpdate.catch(() => {});
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.ui.cancelAll("Hopper host stopped");
		await this.runtime.dispose();
	}

	private async bindSession(session: AgentSession, replaced: boolean): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = session.subscribe((event) => {
			this.bus.publish({ type: "agent_event", event: serializeAgentEvent(event) });
		});

		await session.bindExtensions({
			uiContext: this.ui.context,
			mode: "rpc",
			abortHandler: () => { void session.abort(); },
			shutdownHandler: () => this.onShutdownRequest?.(),
			onError: (error) => this.bus.publish({
				type: "error",
				message: `${error.extensionPath}: ${error.error}`,
			}),
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: (options) => this.runtime.newSession(options),
				fork: (entryId, options) => this.runtime.fork(entryId, options),
				navigateTree: (targetId, options) => session.navigateTree(targetId, options),
				switchSession: (sessionPath, options) => this.runtime.switchSession(sessionPath, options),
				reload: () => session.reload(),
			},
		});

		if (replaced) this.bus.publish({ type: "session_replaced", session: this.snapshot() });
		this.publishSnapshot();
	}

	private assertUsable(): void {
		if (this.disposed) throw new Error("Hopper host is stopped");
	}
}

export type HostRuntime = Pick<
	EmbeddedPiHost,
	| "abort"
	| "dispose"
	| "followUp"
	| "login"
	| "logout"
	| "newSession"
	| "prompt"
	| "setModel"
	| "setThinkingLevel"
	| "snapshot"
	| "steer"
	| "listSkills"
	| "readSkill"
	| "updateSkills"
> & {
	bus: HostMessageBus;
	ui: Pick<BrowserUiContext, "replayPending" | "respond">;
};
