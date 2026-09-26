import { createDocumentTool, executeDocumentTool } from "../../tools/document-tools.js";
import { admitCurrentToolDispatch } from "../../services/tool-policy-context.js";
import type { DocumentKind, DocumentRequest } from "../../types/document-management.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { hostProjectRoot } from "../runtime-paths.js";
import { type Model, type Api } from "@earendil-works/pi-ai";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	type AgentSession,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerPickOptionTool } from "../../extensions/choices/register-pick-option.js";
import { registerAskUserTool } from "../../extensions/choices/register-ask-user.js";
import type { SuspendQuestion } from "../../extensions/choices/ui-helpers.js";
import { createHopperPiExtension } from "../../index.js";
import { serializeAgentEvent, toWireValue } from "../event-serializer.js";
import { RuntimeSessionContext } from "../../infra/runtime-session-context.js";
import { QuestionSuspensionBoundary } from "../question-suspension.js";
import type { DriverContext, TaskDriver } from "./task-service.js";
import type { ImageAttachment } from "../protocol.js";
import { resolvePickOptionAnswer, type PickOption } from "../../types/choices.js";
import { HostSkillLibrary } from "../skills.js";
import { bindToolPolicyModelBoundary } from "../pi-runtime.js";
import { ToolPolicyRuntime, type ToolExecutionScope } from "../../services/tool-policy-runtime.js";

export interface PiDriverOptions {
	dataDirectory: string;
	authPath: string;
	modelConfigDir?: string;
	toolConfigDir?: string;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	/** Normal host preferences directory, shared with the skills UI. */
	skillDataDirectory?: string;
	projectRoot?: string;
	geometry?: (context: DriverContext) => Promise<{
		runtimeSession: RuntimeSessionContext;
		cleanup(): Promise<{ confirmed: boolean; evidence?: unknown }>;
		runTool?: ToolExecutionScope;
	}>;
	delegationTools?: (context: DriverContext) => ToolDefinition[];
	coordinatorTools?: (context: DriverContext) => ToolDefinition[];
	documentActions?: {
		prepare(toolCallId: string, kind: DocumentKind, request: DocumentRequest): string;
	};
	/** Provider injection for deterministic driver tests. */
	configureSession?: (session: AgentSession) => void;
}

export async function createPiTaskDriver(
	context: DriverContext,
	options: PiDriverOptions,
): Promise<TaskDriver> {
	const sessionRoot = join(
		options.dataDirectory,
		"sessions",
		context.conversationId,
		"sessions",
		context.sessionId,
	);
	const workspace = join(options.dataDirectory, "workspaces", context.taskId);
	await Promise.all([
		mkdir(sessionRoot, { recursive: true }),
		mkdir(workspace, { recursive: true }),
	]);
	const geometry = context.binding
		? await options.geometry?.(context)
		: undefined;
	if (context.binding && !geometry)
		throw new Error(
			"Native document routing is not ready for this selected target",
		);
	const runtimeSession = geometry?.runtimeSession ?? new RuntimeSessionContext();
	return runtimeSession.run(async () => {
		const policy = new ToolPolicyRuntime({ embedded: true, questionUi: true, directory: options.toolConfigDir, hostRoutedTools: ["rh_document", "gh_document"] });
		let boundary: QuestionSuspensionBoundary | undefined;
		let session: AgentSession | undefined;
		let cleanupResult: { confirmed: boolean; evidence?: unknown } | undefined;
		const suspend: SuspendQuestion = async (toolCallId, payload) => {
			if (!boundary) throw new Error("Question boundary is not installed");
			return boundary.suspend({
				questionId: "pending", taskId: context.taskId, turnId: context.turnId,
				sessionId: context.sessionId, toolCallId, question: JSON.stringify(payload),
			});
		};
		const tools: ToolDefinition[] = [
			...(context.parentTaskId === null ? (options.delegationTools?.(context) ?? []) : []),
			...(!context.binding ? (options.coordinatorTools?.(context) ?? []) : []),

		];
		const documentTools = (["rhino", "grasshopper"] as const).map(kind => {
			const nativeTool = createDocumentTool(kind);
			return createDocumentTool(kind, async (toolCallId, request) => {
				try {
					if (request.action === "new" || request.action === "open") {
						if (!options.documentActions || context.parentTaskId !== null)
							throw new Error("Ask the root agent to create or open the document.");
						await admitCurrentToolDispatch();
						const grantId = options.documentActions.prepare(toolCallId, kind, request);
						return await boundary!.suspend({ questionId: "pending", taskId: context.taskId,
							turnId: context.turnId, sessionId: context.sessionId, toolCallId,
							question: JSON.stringify({ kind: "document_action", grantId }) }, "document_handoff");
					}
					if (!geometry?.runTool) throw new Error("Select a connected document first. If Rhino is not connected, open Rhino and run HopperCode.");
					if (request.lifecycleInstanceId && request.lifecycleInstanceId !== context.binding?.lifecycleInstanceId)
						throw new Error("This action uses the captured document. Delegate work on another document.");
					const { lifecycleInstanceId: _process, ...nativeRequest } = request;
					return await geometry.runTool(nativeTool.name,
						() => executeDocumentTool(kind, nativeRequest), () => policy.admit(nativeTool.name, undefined, context.signal));
				} catch (error) {
					return { isError: true, content: [{ type: "text", text: String(error) }], details: {} };
				}
			});
		});

		try {
			const skillDataDirectory = options.skillDataDirectory ?? options.dataDirectory;
			// Each task gets a snapshot. Later UI changes apply to the next task without
			// changing the approved files underneath a running model/tool call.
			const skills = new HostSkillLibrary(
				options.projectRoot ?? hostProjectRoot(),
				join(skillDataDirectory, "skills-settings.json"),
				join(skillDataDirectory, "skills"),
			);
			await skills.initialize();
			const services = await createAgentSessionServices({
				cwd: workspace,
				agentDir: join(sessionRoot, "agent"),
				modelRuntime: await ModelRuntime.create({
					authPath: options.authPath,
					modelsPath: join(options.modelConfigDir ?? join(options.dataDirectory, "agent"), "models.json"),
					modelsStorePath: join(options.modelConfigDir ?? join(options.dataDirectory, "agent"), "models-store.json"),
				}),
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					extensionFactories: [
						{ name: "hopper", factory: createHopperPiExtension({
							toolPolicy: policy, runtimeSession, nativeTools: !!geometry,
							runTool: geometry?.runTool, documentTools, scriptWorkspaceDir: workspace,
							sessionId: () => context.sessionId,
						}) },
						{ name: "hopper-choices", factory: (pi) => {
							pi.on("session_start", async () => {
								const guarded = Object.create(pi) as ExtensionAPI;
								guarded.registerTool = (tool) => { policy.register(pi, tool as unknown as ToolDefinition); };
								registerPickOptionTool(guarded, suspend);
								registerAskUserTool(guarded, suspend);
								await policy.reconcile();
							});
						} },
					],
				},
			});
			services.resourceLoader.getSkills = () => policy.isToolExposed("read") ? skills.getSkills() : { skills: [], diagnostics: [] };
			let model: Model<Api> | undefined;
			if (options.model) {
				model = services.modelRuntime.getModel(
					options.model.provider,
					options.model.id,
				);
				if (!model) throw new Error("Selected model is unavailable");
			}
			// The journal's conversation/session directory owns the history. Task
			// workspaces change between prompts, so Pi's cwd-filtered discovery loses it.
			const previousSession = (await SessionManager.listAll(sessionRoot))[0];
			const created = await createAgentSessionFromServices({
				services,
				sessionManager: previousSession
					? SessionManager.open(previousSession.path, sessionRoot, workspace)
					: SessionManager.create(workspace, sessionRoot),
				noTools: "builtin",
				customTools: [...tools, policy.customTool(skills.createReadTool(workspace))],
				...(model ? { model } : {}),
			});
			session = created.session;
			if (options.thinkingLevel !== undefined) {
				const level = session.getAvailableThinkingLevels().find((candidate) => candidate === options.thinkingLevel);
				if (!level) throw new Error(`Thinking level is unavailable: ${options.thinkingLevel}`);
				session.setThinkingLevel(level);
			}
			await session.bindExtensions({
				mode: "rpc",
				abortHandler: () => {
					void session!.abort();
				},
				onError: (error) =>
					context.publish({ type: "driver_error", message: error.error }),
			});
			const sharedPrompt = `\nShared task ${context.taskId}, turn ${context.turnId}. ${context.binding
				? `Selected document: ${JSON.stringify(context.binding)}. Use your native geometry tools directly for this document.`
					: `Message document: ${JSON.stringify(context.messageTarget ?? null)}. Accessible documents: ${JSON.stringify(context.accessibleBindings ?? [])}. Start with the message document when the user says this model or this document. Use delegate to read or edit these documents as needed.`} ${context.parentTaskId === null ? `You may also access these documents: ${JSON.stringify(context.accessibleBindings ?? [])}. Use listRhinoTargets to see their names and delegate only when work needs another document. No per-document permission is needed. The selected document remains your own target. Submit independent delegate assignments without dependencies, then call waitForDelegates once to collect them together. Use dependencies only when one assignment needs another's result. Use rh_document or gh_document with action new/open to create or open files in a connected process. If no process is connected, ask the user to open Rhino and run HopperCode. ${tools.some(tool => tool.name === "launchRhino") ? "On Windows, rh_document new/open replaces the current model. Use launchRhino to create an additional process for delegation, then delegate to its returned binding. Launching preserves your selected document. Inspect the new default model units before modeling. Reuse the same requestId after a timeout; never launch a replacement while its outcome is unresolved." : "On macOS, rh_document new creates another document in the same process. Process launching is unavailable in this task."}` : ""} A user question ends this turn. Do not assume a new active Rhino window changes your target. If you delegate, call waitForDelegates to collect child results before summarizing. Create/open finishes the current editing segment and resumes with the resulting document. Unsaved changes are preserved by default; ask the user about save/discard only when their request has not resolved that choice. Agents run concurrently, including across documents in the same Mac Rhino process. Native tool calls take turns under a process lock, reactivate your captured document, and finish their editing segment before releasing Rhino. Reinspect objects before edits if another task may have changed the same document.`;
			const refreshTools = bindToolPolicyModelBoundary(session, policy, sharedPrompt);
			options.configureSession?.(session);
			boundary = new QuestionSuspensionBoundary(
				session.agent,
				async (question) => {
					const payload = JSON.parse(question.question);
					const id =
						payload.kind === "document_action"
							? context.requestDocumentAction(payload.grantId)
							: context.ask(question.toolCallId, payload);
					// The result must carry the committed journal identity, never a new question.
					return id;
				},
			);
			const initialMessageCount = session.messages.length;
			const pendingSteering = new Map<
				number,
				{ text: string; resolve(): void; reject(error: Error): void }
			>();
			const previousUsage = session.messages
				.filter((message) => message.role === "assistant")
				.reduce((sum, message) => sum + message.usage.totalTokens, 0);
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "message_start" && event.message.role === "user") {
					const content =
						typeof event.message.content === "string"
							? event.message.content
							: event.message.content
									.filter((part) => part.type === "text")
									.map((part) => part.text)
									.join("\n");
					for (const [id, pending] of pendingSteering)
						if (content === pending.text) {
							pendingSteering.delete(id);
							pending.resolve();
						}
				}
				// The shared UI is driven by the durable task journal, so record compact
				// assistant events as they arrive instead of leaving the conversation blank
				// until agent_end publishes its final messages.
				if (
					(event.type === "message_start" && event.message.role === "assistant") ||
					event.type === "message_update" ||
					(event.type === "message_end" && event.message.role === "assistant")
				)
					context.publish({
						type: "agent_event",
						turnId: context.turnId,
						event: serializeAgentEvent(event),
					});
				if (
					event.type === "tool_execution_start" ||
					event.type === "tool_execution_update" ||
					event.type === "tool_execution_end"
				)
					context.publish({
						type: "tool_progress",
						phase:
							event.type === "tool_execution_start" ? "started" : event.type === "tool_execution_update" ? "updated" : "completed",
						turnId: context.turnId,
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						event: serializeAgentEvent(event),
						...(event.type === "tool_execution_end" ? { isError: event.isError } : {}),
					});
				if (event.type === "agent_end")
					context.publish({
						type: "messages",
						turnId: context.turnId,
						messages: toWireValue(session!.messages.slice(initialMessageCount)),
					});
			});
			const abort = () => {
				void session!.abort();
			};
			context.signal.addEventListener("abort", abort, { once: true });
			const registeredSnapshot = (snapshot: import("../protocol.js").AgentToolsSnapshot) => {
				const registered = new Set(session!.getAllTools().map(tool => tool.name));
				return { ...snapshot, tools: snapshot.tools.filter(tool => registered.has(tool.name)) };
			};
			return {
				toolSettings: {
					getToolSettings: () => runtimeSession.run(async () => registeredSnapshot(await policy.getToolSettings())),
					updateToolSettings: action => runtimeSession.run(async () => {
						const result = await policy.updateToolSettings(action);
						return { ...result, snapshot: registeredSnapshot(result.snapshot) };
					}),
				},
				run: () => runtimeSession.run(async () => {
					if (context.signal.aborted)
						throw new Error("Task was cancelled before model dispatch");
					const continuation = context.continuation as { payload?: { kind?: string; question: string; options: PickOption[] }; answer: string | null } | null;
					const answered = continuation?.payload?.kind === "pick_option"
						? { ...continuation, result: resolvePickOptionAnswer(continuation.payload.question, continuation.payload.options, continuation.answer) }
						: continuation;
					const prompt = context.continuation
						? `Continue in a fresh turn after ${"documentAction" in Object(context.continuation) ? "the document action result; inspect success or failure before continuing with the captured binding" : "the user's answer"}.\n${JSON.stringify(answered)}`
						: skills.expandCommand(context.text);
					await refreshTools();
					await session!.agent.prompt(
						prompt,
						context.attachments as ImageAttachment[],
					);
					const usage = session!.messages
						.filter((message) => message.role === "assistant")
						.reduce((sum, message) => sum + message.usage.totalTokens, 0);
					const used = Math.max(0, usage - previousUsage);
					const last = session!.messages
						.slice(initialMessageCount)
						.filter((message) => message.role === "assistant")
						.at(-1);
					if (
						last &&
						(last.stopReason === "error" || last.stopReason === "aborted")
					) {
						const error = new Error(
							last.errorMessage ?? `Model response ${last.stopReason}`,
						) as Error & { usage: number };
						error.usage = used;
						throw error;
					}
					return { usage: used };
				}),
				steer: (payload, inputId = 0) => runtimeSession.run(async () => {
					const input = payload as {
						text: string;
						attachments?: ImageAttachment[];
					};
					const text = `[Steering input ${inputId}]\n${skills.expandCommand(input.text)}`;
					const consumed = new Promise<void>((resolve, reject) =>
						pendingSteering.set(inputId, { text, resolve, reject }),
					);
					void consumed.catch(() => {});
					try {
						await session!.steer(text, input.attachments);
					} catch (error) {
						pendingSteering.delete(inputId);
						throw error;
					}
					await consumed;
				}),
				cancel: () => runtimeSession.run(() => session!.abort()),
				cleanup: () => runtimeSession.run(async () => {
					if (cleanupResult) return cleanupResult;
					await session!.waitForIdle();
					session!.agent.clearAllQueues();
					for (const pending of pendingSteering.values()) {
						const error = new Error(
							"Steering was not consumed before this turn ended",
						);
						error.name = "SteeringNotAppliedError";
						pending.reject(error);
					}
					pendingSteering.clear();
					boundary!.dispose();
					try {
						cleanupResult = geometry
							? await geometry.cleanup()
							: {
									confirmed: true,
									evidence: { kind: "discussion", nativeOperations: 0 },
								};
						return cleanupResult;
					} finally {
						context.signal.removeEventListener("abort", abort);
						unsubscribe();
						await policy.close();
						session!.dispose();
					}
				}),
			};
		} catch (error) {
			await policy.close();
			boundary?.dispose();
			session?.dispose();
			let cleanupConfirmed = !geometry;
			try {
				if (geometry) cleanupConfirmed = (await geometry.cleanup()).confirmed;
			} catch {
				cleanupConfirmed = false;
			}
			throw Object.assign(
				error instanceof Error ? error : new Error(String(error)),
				{ cleanupConfirmed },
			);
		}
	});
}
