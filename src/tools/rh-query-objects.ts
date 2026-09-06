import { formatDocumentSettings } from "../services/document-management.js";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { withRequester } from "../infra/request-helpers.js";
import {
	resolveRhinoGuid,
	toShortRhinoGuid,
} from "../services/guid-shortener.js";
import type { QueryRhinoObjectsResponse } from "../types/messages.js";
import { ResultLimitSchema, ResultOffsetSchema, RhinoObjectTypeSchema } from "./schemas.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function paginate<T>(items: T[], limit?: number, offset?: number): {
	slice: T[];
	hasMore: boolean;
	total: number;
	offset: number;
} {
	const total = items.length;
	const effectiveLimit = Math.min(Math.max(Math.trunc(limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
	const effectiveOffset = Math.max(Math.trunc(offset ?? 0), 0);
	const slice = items.slice(effectiveOffset, effectiveOffset + effectiveLimit);
	return {
		slice,
		hasMore: effectiveOffset + slice.length < total,
		total,
		offset: effectiveOffset,
	};
}

export const rhQueryObjectsTool = defineTool({
	name: "rh_query_objects",
	label: "Query Rhino Objects",
	description:
		"List Rhino document objects with short objectId aliases for gh_param_rhino. " +
		"Filter by selection, exact layer, geometry kind, and/or IDs. Use countOnly before large operations. " +
		"For a whole layer or large set, pass the same filters directly to gh_param_rhino.rhinoQuery instead of listing IDs.",
	promptSnippet: "List or count filtered Rhino document objects and return short IDs",
	parameters: Type.Object({
		selectionOnly: Type.Optional(
			Type.Boolean({ description: "Only objects currently selected in Rhino" }),
		),
		layer: Type.Optional(
			Type.String({ description: "Filter by layer name (exact match)" }),
		),
		objectType: Type.Optional(RhinoObjectTypeSchema),
		objectIds: Type.Optional(
			Type.Array(
				Type.String({ description: "Rhino object ID (short or full)" }),
				{ minItems: 1, description: "Return only these Rhino object IDs" },
			),
		),
		countOnly: Type.Optional(
			Type.Boolean({ description: "Return match count only, no object list" }),
		),
		limit: Type.Optional(ResultLimitSchema),
		offset: Type.Optional(ResultOffsetSchema),
	}),

	async execute(_toolCallId, params) {
		const requestParams = {
			selectionOnly: params.selectionOnly,
			layer: params.layer,
			objectType: params.objectType,
			objectIds: params.objectIds?.map(resolveRhinoGuid),
		};

		const res = await withRequester((req) =>
			req.request<QueryRhinoObjectsResponse | { error?: string }>({
				type: "queryRhinoObjects",
				...requestParams,
			}),
		);

		if ("error" in res && res.error) {
			return {
				content: [{ type: "text", text: `FAILED: ${res.error}` }],
				details: {},
			};
		}

		const settings = formatDocumentSettings("settings" in res ? res.settings : undefined);
		const objects = "objects" in res ? res.objects : [];
		if (objects.length === 0) {
			return {
				content: [{ type: "text", text: settings + "No Rhino objects matched the query." }],
				details: {},
			};
		}

		if (params.countOnly) {
			const filters: string[] = [];
			if (params.layer) filters.push(`layer="${params.layer}"`);
			if (params.objectType) filters.push(`type=${params.objectType}`);
			if (params.selectionOnly) filters.push("selectionOnly");
			const filterNote = filters.length > 0 ? ` (${filters.join(", ")})` : "";
			return {
				content: [
					{
						type: "text",
						text:
							settings + `${objects.length} Rhino object(s) matched${filterNote}. ` +
							"Use gh_param_rhino with rhinoQuery to reference/internalize in bulk without listing IDs.",
					},
				],
				details: {},
			};
		}

		const { slice, hasMore, total, offset } = paginate(objects, params.limit, params.offset);

		const lines = slice.map((o) => {
			const shortId = toShortRhinoGuid(o.objectId);
			return `${shortId}  ${o.objectType}  layer="${o.layer}"  name="${o.name || "(unnamed)"}"`;
		});

		const header =
			total === slice.length
				? `${total} Rhino object(s):`
				: `${total} Rhino object(s) (showing ${offset + 1}-${offset + slice.length}):`;
		const footer = hasMore
			? `\n  ... ${total - offset - slice.length} more (call with offset=${offset + slice.length})`
			: "";

		return {
			content: [
				{
					type: "text",
					text: settings + `${header}\n${lines.join("\n")}${footer}`,
				},
			],
			details: {},
		};
	},
});
