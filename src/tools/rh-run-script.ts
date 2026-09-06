import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { validateRhinoScriptItem } from "../services/rhino-script-validator.js";
import { formatToolFailed } from "./result-formatters.js";
import { runRhinoScript } from "./rhino-script-handlers.js";
import type { ScriptToolContext } from "./rh-script.js";
import type { RunItem } from "../types/rhino-script-workspace.js";

const ROUTING_PREFIX =
	"Use rh_run_script for Rhino document work (geometry, layers, selection, blocks, direct bake, materials). " +
	"Use rh_view_control for normal viewport/camera changes, rh_query_objects for object IDs, and gh_* tools for the Grasshopper canvas. ";

export function createRhRunScriptTool(getContext?: () => ScriptToolContext) {
	return defineTool({
		name: "rh_run_script",
		label: "Run Rhino Script",
		description:
			ROUTING_PREFIX +
			"Runs Rhino command macros or Python/C# scripts on the active RhinoDoc (Rhino 8 RhinoCode). " +
			"Prefer Python for multi-step work and command mode for one-liners. Use print() / Console.WriteLine() for returned output. " +
			"Inline-only batches continue after errors. Asset or mixed batches pin every revision, journal execution, and stop after failure or uncertainty. Editing saved source never executes it. Rerunning can add more geometry. Changes share one Rhino Undo record per agent turn.",
		promptSnippet:
			"Run command, Python, or C# against the active Rhino document",
		parameters: Type.Object({
			items: Type.Array(
				Type.Union([
					Type.Object(
						{
							mode: Type.Union(
								[
									Type.Literal("command"),
									Type.Literal("python"),
									Type.Literal("csharp"),
								],
								{
									description:
										"command = Rhino macro string; python = Rhino Python (scriptcontext/rs); csharp = Rhino C# script editor body",
								},
							),
							source: Type.String({
								description: "Command macro or script source",
							}),
							echo: Type.Optional(
								Type.Boolean({
									description:
										"Echo command to history (command mode only, default false)",
								}),
							),
						},
						{ additionalProperties: false },
					),
					Type.Object(
						{
							scriptId: Type.String(),
							revision: Type.Integer({
								minimum: 1,
								maximum: Number.MAX_SAFE_INTEGER,
							}),
							expectedDocument: Type.Object(
								{
									documentId: Type.String({ minLength: 1 }),
									lifecycleInstanceId: Type.String({ minLength: 1 }),
									settingsRevision: Type.Optional(
										Type.String({ minLength: 1 }),
									),
								},
								{ additionalProperties: false },
							),
							expectedSettingsRevision: Type.Optional(
								Type.String({ minLength: 1 }),
							),
						},
						{ additionalProperties: false },
					),
				]),
				{ minItems: 1, maxItems: 100 },
			),
		}),

		async execute(toolCallId, params, signal, onUpdate) {
			if (params.items.some((item) => "scriptId" in item)) {
				try {
					if (!getContext)
						throw new Error(
							"Script workspace is unavailable; load the Hopper extension",
						);
					const { execution, sessionId } = getContext();
					const result = await execution.runBatch(
						params.items as RunItem[],
						`${sessionId}:rh_run_script:${toolCallId}`,
						signal,
					);
					return {
						content: [
							{ type: "text" as const, text: JSON.stringify(result, null, 2) },
						],
						details: result,
					};
				} catch (error) {
					return {
						isError: true,
						content: [{ type: "text" as const, text: formatToolFailed(error) }],
						details: {},
					};
				}
			}
			const results: string[] = [];

			for (const item of params.items) {
				if ("scriptId" in item) continue;
				if (signal?.aborted) break;
				const validationError = validateRhinoScriptItem(item);
				if (validationError) {
					results.push(formatToolFailed(validationError));
					continue;
				}

				onUpdate?.({
					content: [
						{ type: "text", text: `Running Rhino ${item.mode} script...` },
					],
					details: {},
				});

				try {
					results.push(await runRhinoScript(item));
				} catch (err) {
					results.push(formatToolFailed(err));
				}
			}

			return {
				content: [{ type: "text", text: results.join("\n\n") }],
				details: {},
			};
		},
	});
}

export const rhRunScriptTool = createRhRunScriptTool();
