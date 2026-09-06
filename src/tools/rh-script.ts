import {
	Type,
	type Static,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
	RhinoScriptWorkspace,
	type ScriptMutation,
} from "../services/rhino-script-workspace.js";
import {
	RhinoScriptExecution,
	publicRun,
} from "../services/rhino-script-execution.js";
import { ScriptWorkspaceError } from "../services/source-line-patches.js";
const revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const scriptId = Type.String();
const lines = Type.Array(Type.String({ pattern: "^[^\\r\\n]*$" }));
const pagination = {
	offset: Type.Optional(Type.Integer({ minimum: 0 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
};
const mutation = {
	mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
};
const head = { scriptId, expectedRevision: revision, ...mutation };
const patch = Type.Union([
	Type.Object(
		{
			action: Type.Literal("insert"),
			afterLine: Type.Integer({ minimum: 0 }),
			lines,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("replace"),
			startLine: revision,
			endLine: revision,
			lines,
			expectedText: Type.Optional(Type.String()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("delete"),
			startLine: revision,
			endLine: revision,
			expectedText: Type.Optional(Type.String()),
		},
		{ additionalProperties: false },
	),
]);
const rhScriptActions = Type.Union([
	Type.Object(
		{
			action: Type.Literal("create"),
			name: Type.String({ minLength: 1, maxLength: 200 }),
			language: Type.Union([Type.Literal("python"), Type.Literal("csharp")]),
			source: Type.String({ maxLength: 64000 }),
			...mutation,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("list"),
			name: Type.Optional(Type.String()),
			includeDeleted: Type.Optional(Type.Boolean()),
			...pagination,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("get"),
			scriptId,
			revision: Type.Optional(revision),
			startLine: Type.Optional(revision),
			endLine: Type.Optional(Type.Integer({ minimum: 0 })),
			characterOffset: Type.Optional(
				Type.Integer({
					minimum: 0,
					description:
						"Continue a long partial line at the returned nextCharacterOffset",
				}),
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ action: Type.Literal("patch"), ...head, patches: Type.Array(patch) },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("setSource"),
			...head,
			source: Type.String({ maxLength: 64000 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("rename"),
			...head,
			name: Type.String({ minLength: 1, maxLength: 200 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ action: Type.Literal("restore"), ...head, fromRevision: revision },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Union([Type.Literal("delete"), Type.Literal("undelete")]),
			...head,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ action: Type.Literal("history"), scriptId, ...pagination },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("diff"),
			scriptId,
			fromRevision: revision,
			toRevision: revision,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Union([
				Type.Literal("getRun"),
				Type.Literal("reconcileRun"),
			]),
			runId: Type.String(),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ action: Type.Literal("getExecutionTarget") },
		{ additionalProperties: false },
	),
]);
// Providers require an object at the schema root. Validate the stricter action
// union locally so required fields and extra fields still receive exact errors.
export const rhScriptParameters = Type.Unsafe<Static<typeof rhScriptActions>>({
	type: "object",
	properties: {
		...Object.assign(
			{},
			...rhScriptActions.anyOf.map((action) => action.properties),
		),
		action: {
			type: "string",
			enum: [
				"create",
				"list",
				"get",
				"patch",
				"setSource",
				"rename",
				"restore",
				"delete",
				"undelete",
				"history",
				"diff",
				"getRun",
				"reconcileRun",
				"getExecutionTarget",
			],
		},
	},
	required: ["action"],
	additionalProperties: false,
});
export type ScriptToolContext = {
	workspace: RhinoScriptWorkspace;
	execution: RhinoScriptExecution;
	sessionId: string;
};
export function createRhScriptTool(getContext: () => ScriptToolContext) {
	return defineTool({
		name: "rh_script",
		label: "Edit saved Rhino scripts",
		description:
			"Create, inspect and patch persistent Rhino Python/C# source assets without executing them. Edits use 1-based original-revision lines and expectedRevision. getExecutionTarget reads the active document's identity, units and tolerances; run the chosen revision explicitly with rh_run_script. Local source/history/getRun actions work offline. restore changes source only, never geometry. getRun/reconcileRun never resubmit source.",
		parameters: rhScriptParameters,
		async execute(toolCallId, params) {
			try {
				validateToolArguments(
					{
						name: "rh_script",
						description: "Saved script actions",
						parameters: rhScriptActions,
					},
					{
						type: "toolCall",
						id: toolCallId,
						name: "rh_script",
						arguments: params,
					},
				);
				const { workspace, execution, sessionId } = getContext();
				let result: unknown;
				switch (params.action) {
					case "list":
						result = workspace.list(
							params.name,
							params.includeDeleted,
							params.offset,
							params.limit,
						);
						break;
					case "get":
						result = workspace.get(
							params.scriptId,
							params.revision,
							params.startLine,
							params.endLine,
							params.characterOffset,
						);
						break;
					case "history":
						result = workspace.history(
							params.scriptId,
							params.offset,
							params.limit,
						);
						break;
					case "diff":
						result = workspace.diff(
							params.scriptId,
							params.fromRevision,
							params.toRevision,
						);
						break;
					case "getRun":
						result = publicRun(execution.getRun(params.runId));
						break;
					case "reconcileRun":
						result = publicRun(await execution.reconcileRun(params.runId));
						break;
					case "getExecutionTarget":
						result = await execution.getExecutionTarget();
						break;
					default: {
						const { mutationId, ...request } = params;
						result = workspace.mutate(
							request as ScriptMutation,
							`${sessionId}:rh_script:${mutationId ?? toolCallId}`,
						);
					}
				}
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(result, null, 2) },
					],
					details: result,
				};
			} catch (error) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: String(error) }],
					details:
						error instanceof ScriptWorkspaceError
							? {
									code: error.code,
									...(error.details ? { context: error.details } : {}),
								}
							: {},
				};
			}
		},
	});
}
