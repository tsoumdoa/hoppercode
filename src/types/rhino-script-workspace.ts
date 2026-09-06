export type ScriptLanguage = "python" | "csharp";
export type SourcePatch =
	| { action: "insert"; afterLine: number; lines: string[] }
	| {
			action: "replace";
			startLine: number;
			endLine: number;
			lines: string[];
			expectedText?: string;
	  }
	| {
			action: "delete";
			startLine: number;
			endLine: number;
			expectedText?: string;
	  };
export type ScriptRevision = {
	revision: number;
	name: string;
	language: ScriptLanguage;
	source: string;
	hash: string;
	deleted: boolean;
	createdAt: string;
};
export type ScriptRecord = {
	schemaVersion: 1;
	workspaceId: string;
	scriptId: string;
	revisions: ScriptRevision[];
	mutations: Record<
		string,
		{ payloadHash: string; revision: number; changed: boolean }
	>;
};
export type ExecutionDocument = {
	documentId: string;
	lifecycleInstanceId: string;
	settingsRevision?: string;
};
export type ScriptRunItem = {
	scriptId: string;
	revision: number;
	expectedDocument: ExecutionDocument;
};
export type InlineRunItem = {
	mode: "python" | "csharp" | "command";
	source: string;
	echo?: boolean;
};
export type RunItem = ScriptRunItem | InlineRunItem;
export type RunState =
	| "prepared"
	| "dispatching"
	| "completed"
	| "failed"
	| "notStarted"
	| "outcome_unknown"
	| "notRun";
export type RunRecord = {
	schemaVersion: 1;
	workspaceId: string;
	runId: string;
	batchId: string;
	version: number;
	payloadHash: string;
	operationId: string;
	lifecycleInstanceId: string;
	expectedDocument?: ExecutionDocument;
	scriptId?: string;
	revision?: number;
	sourceHash: string;
	mode: InlineRunItem["mode"];
	source: string;
	echo?: boolean;
	state: RunState;
	owner: { pid: number; processId: string; claimId: string };
	createdAt: string;
	updatedAt: string;
	result?: unknown;
	output?: string;
	outputTruncated?: boolean;
	error?: string;
	settings?: unknown;
	recordingError?: string;
};
export type BatchRecord = {
	schemaVersion: 1;
	workspaceId: string;
	batchId: string;
	payloadHash: string;
	runIds: string[];
	runs: RunRecord[];
};
