import { addCustomProvider, type CustomProviderInput } from "./provider-config.js";
import { RuntimeSessionContext } from "../infra/runtime-session-context.js";
import { closeRuntimeRpc } from "../infra/runtime-rpc.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { hostProjectRoot } from "./runtime-paths.js";
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
import type { AgentToolsSnapshot, ImageAttachment, HostSnapshot, SkillLibrarySnapshot, SkillLibraryUpdate } from "./protocol.js";
import { HostSkillLibrary } from "./skills.js";
import { BrowserUiContext } from "./web-ui-context.js";
import { ToolPolicyRuntime } from "../services/tool-policy-runtime.js";
import type { ToolSettingsAction } from "./protocol.js";

export type EmbeddedPiHostOptions = {
	/** Disable automatic native probes for the shared host's unattached settings session. */
	probeBackend?: boolean;
	runtimeSession?: RuntimeSessionContext;
	paths: HostPaths;
	projectRoot?: string;
	bus?: HostMessageBus;
	onShutdownRequest?: () => void;
};

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

/** Pi snapshots tool definitions after compaction for each continuation. */
export function bindToolPolicyModelBoundary(session: AgentSession, policy: ToolPolicyRuntime, promptSuffix = ""): () => Promise<void> {
	type AgentMessage = AgentSession["agent"]["state"]["messages"][number];
	const addPromptSuffix = <T extends { messages: AgentMessage[] }>(context: T): T => {
		if (!promptSuffix || context.messages.some(message => message.role === "system" &&
			(typeof message.content === "string" ? message.content : "").endsWith(promptSuffix))) return context;
		return { ...context, messages: [...context.messages, { role: "system", content: promptSuffix, timestamp: Date.now() }] as AgentMessage[] };
	};
	const refresh = async () => {
		await policy.reconcile(true);
	};
	const prepare = session.agent.prepareNextTurnWithContext;
	session.agent.prepareNextTurnWithContext = async (turn, signal) => {
		const next = await prepare?.(turn, signal);
		await refresh();
		const context = addPromptSuffix(next?.context ?? turn.context);
		return { ...next, context: { ...context, tools: session.agent.state.tools.slice() } };
	};
	const prepareRequest = session.agent.prepareRequest;
	session.agent.prepareRequest = async (request, signal) => {
		const next = await prepareRequest?.(request, signal);
		await refresh();
		const context = addPromptSuffix(next?.context ?? request.context);
		return { ...next, context: { ...context, tools: session.agent.state.tools.slice() } };
	};
	return refresh;
}

export class EmbeddedPiHost {
	readonly bus: HostMessageBus;
	readonly ui: BrowserUiContext;
	private unsubscribe?: () => void;
	private disposed = false;
	private skillUpdate?: Promise<void>;
	private authRefresh?: Promise<void>;
	private promptPending = false;
	private promptGeneration = 0;

	private constructor(
		private readonly runtime: AgentSessionRuntime,
		bus: HostMessageBus,
		ui: BrowserUiContext,
		private readonly skills: HostSkillLibrary,
		private readonly onShutdownRequest?: () => void,
		private readonly currentPolicy?: () => ToolPolicyRuntime,
		private readonly runtimeSession = new RuntimeSessionContext(),
	) {
		this.bus = bus;
		this.ui = ui;
	}

	static async create(options: EmbeddedPiHostOptions): Promise<EmbeddedPiHost> {
		const runtimeSession = options.runtimeSession ?? new RuntimeSessionContext();
		return runtimeSession.run(() => EmbeddedPiHost.createInSession(options, runtimeSession));
	}

	private static async createInSession(options: EmbeddedPiHostOptions, runtimeSession: RuntimeSessionContext): Promise<EmbeddedPiHost> {
		const projectRoot = options.projectRoot ?? hostProjectRoot();
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

		let host: EmbeddedPiHost | undefined;
		let currentPolicy: ToolPolicyRuntime;
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const policy = new ToolPolicyRuntime({ embedded: true, directory: paths.toolConfigDir, probeBackendOnReconcile: options.probeBackend });
			currentPolicy = policy;
			policy.onChange = snapshot => host?.bus.publish({ type: "tool_settings", snapshot });
			const services = await createAgentSessionServices({
				cwd,
				agentDir: paths.agentDir,
				modelRuntime,
				resourceLoaderOptions: isolatedResourceLoaderOptions({
					backendStatusUI: options.probeBackend,
					toolPolicy: policy,
					runtimeSession,
					scriptWorkspaceDir: paths.scriptWorkspaceDir ?? join(paths.dataDir, "workspaces", "default"),
					scriptWorkspaceQuotaBytes: paths.scriptWorkspaceQuotaBytes,
					sessionId: () => sessionManager.getSessionId(),
				}),
			});
			// Keep skill discovery live without reloading extensions or changing active tools.
			services.resourceLoader.getSkills = () => policy.isToolExposed("read") ? skills.getSkills() : { skills: [], diagnostics: [] };
			const created = await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					noTools: "builtin",
					customTools: [policy.customTool(skills.createReadTool(cwd))],
				});
			bindToolPolicyModelBoundary(created.session, policy);
			return {
				...created,
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: paths.workspaceDir,
			agentDir: paths.agentDir,
			sessionManager: SessionManager.continueRecent(paths.workspaceDir, paths.sessionsDir),
		});
		host = new EmbeddedPiHost(runtime, bus, ui, skills, options.onShutdownRequest, () => currentPolicy, runtimeSession);
		runtime.setRebindSession(async (session) => host!.bindSession(session, true));
		await host.bindSession(runtime.session, false);
		host.modelsPath = join(paths.agentDir, "models.json");
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

	listTools(): AgentToolsSnapshot {
		this.assertUsable();
		const session = this.runtime.session;
		const active = new Set(session.getActiveToolNames());
		return { tools: session.getAllTools().map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: toWireValue(tool.parameters),
			active: active.has(tool.name),
		})).sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)) };
	}

	async getToolSettings(backendPreview?: boolean) {
		this.assertUsable();
		return this.runtimeSession.run(() => this.currentPolicy ? this.currentPolicy().getToolSettings(backendPreview) : this.listTools());
	}

	async updateToolSettings(action: ToolSettingsAction) {
		this.assertUsable();
		if (!this.currentPolicy) throw new Error("Tool settings are unavailable");
		return this.runtimeSession.run(() => this.currentPolicy!().updateToolSettings(action));
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
		await this.refreshAuth();
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

	/** Reload credentials changed by the global Pi CLI without fetching model catalogs. */
	async refreshAuth(): Promise<void> {
		this.assertUsable();
		if (!this.authRefresh) {
			this.authRefresh = this.runtime.services.modelRuntime.refresh({ allowNetwork: false })
				.then(() => { if (!this.disposed) this.publishSnapshot(); })
				.finally(() => { this.authRefresh = undefined; });
		}
		await this.authRefresh;
	}

	private authController?: AbortController;
	private modelsPath?: string;

	cancelAuth(): void { this.authController?.abort(); }

	async refreshProviders(): Promise<void> {
		await this.refreshAuth();
		const error = this.runtime.services.modelRuntime.getError();
		if (error) throw new Error(error);
		this.bus.publish({ type: "status", status: "authenticated", scope: "auth" });
	}

	async addProvider(config: CustomProviderInput): Promise<void> {
		this.assertUsable();
		if (!this.modelsPath) throw new Error("Model configuration is unavailable");
		if (this.runtime.services.modelRuntime.getProvider(config.id)) throw new Error("A provider with this name already exists");
		await addCustomProvider(this.modelsPath, config);
		// A periodic refresh may have read the file before this write. Wait for it, then reload.
		await this.authRefresh;
		await this.refreshAuth();
		const error = this.runtime.services.modelRuntime.getError();
		if (error) throw new Error("Provider definition was saved but could not be loaded. Check model configuration.");
		if (config.apiKey) {
			try { await this.login(config.id, "api_key", config.apiKey); }
			catch { throw new Error("Provider definition saved, but credentials were not saved. Find this provider in Add provider and retry its setup."); }
		}
		else {
			this.bus.publish({ type: "status", status: "authenticated", scope: "auth", provider: config.id });
			this.publishSnapshot();
		}
	}

	async login(provider: string, authType: AuthType, apiKey?: string): Promise<void> {
		this.assertUsable();
		if (this.authController) throw new Error("A sign-in is already in progress");
		const controller = new AbortController();
		this.authController = controller;
		const timeout = setTimeout(() => controller.abort(), 300_000);
		let suppliedApiKey = apiKey;
		try {
			await this.runtime.services.modelRuntime.login(provider, authType, {
				signal: controller.signal,
				prompt: (prompt) => {
					if (prompt.type === "secret" && suppliedApiKey) {
						const value = suppliedApiKey;
						suppliedApiKey = undefined;
						return Promise.resolve(value);
					}
					return this.ui.requestAuthPrompt({ ...prompt, signal: prompt.signal ? AbortSignal.any([prompt.signal, controller.signal]) : controller.signal });
				},
				notify: (event) => this.ui.notifyAuth(event),
			});
		} finally { clearTimeout(timeout); this.authController = undefined; }
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
				name: provider.id.startsWith("custom-") ? provider.id.slice(7).replace(/-/g, " ").replace(/^./, c => c.toUpperCase()) : provider.name,
				authenticated: this.runtime.services.modelRuntime.hasConfiguredAuth(provider.id),
				authMethods: providerAuthMethods(provider.auth),
				credentialSource: this.runtime.services.modelRuntime.getProviderAuthStatus(provider.id).source,
				credentialLabel: this.runtime.services.modelRuntime.getProviderAuthStatus(provider.id).label,
				canLogout: this.runtime.services.modelRuntime.getProviderAuthStatus(provider.id).source === "stored",
			})),
		};
	}

	publishSnapshot(): void {
		this.bus.publish({ type: "snapshot", snapshot: this.snapshot() });
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.cancelAuth();
		await this.authRefresh?.catch(() => {});
		if (this.skillUpdate) await this.skillUpdate.catch(() => {});
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.ui.cancelAll("Hopper host stopped");
		try { await this.runtime.dispose(); }
		finally { await this.runtimeSession.run(closeRuntimeRpc); }
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

	exportSession() {
		this.assertUsable();
		const session = this.runtime.session;
		return {
			format: "hopper-session-debug",
			version: 1,
			exportedAt: new Date().toISOString(),
			sessionId: session.sessionId,
			sessionName: session.sessionName,
			header: session.sessionManager.getHeader(),
			leafId: session.sessionManager.getLeafId(),
			entries: session.sessionManager.getEntries(),
			messages: session.messages,
			systemPrompt: session.systemPrompt,
			model: session.model ? modelSummary(session.model) : undefined,
			thinkingLevel: session.thinkingLevel,
			isStreaming: session.isStreaming,
			isCompacting: session.isCompacting,
			streamingMessage: session.agent.state.streamingMessage ?? null,
		};
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
	| "addProvider"
	| "refreshProviders"
	| "cancelAuth"
	| "logout"
	| "newSession"
	| "prompt"
	| "setModel"
	| "setThinkingLevel"
	| "snapshot"
	| "exportSession"
	| "steer"
	| "listSkills"
	| "listTools"
	| "getToolSettings"
	| "updateToolSettings"
	| "readSkill"
	| "updateSkills"
> & {
	bus: HostMessageBus;
	ui: Pick<BrowserUiContext, "replayPending" | "respond">;
};
