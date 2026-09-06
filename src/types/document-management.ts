export type DocumentKind = "rhino" | "grasshopper";
export type UnsavedPolicy = "fail" | "save" | "discard";
export type DocumentAction = "list" | "get" | "getSettings" | "browse" | "new" | "open" | "activate" | "save" | "saveAs" | "close";
export type AffectedDocument = {
	documentId: string;
	expectedStateToken: string;
	onUnsaved: UnsavedPolicy;
	savePath?: string;
	overwrite?: boolean;
};
export type DocumentRequest = {
	action: DocumentAction;
	documentId?: string;
	expectedStateToken?: string;
	expectedActiveDocument?: string | null;
	path?: string;
	onUnsaved?: UnsavedPolicy;
	savePath?: string;
	overwrite?: boolean;
	affectedDocuments?: AffectedDocument[];
	cursor?: string;
	limit?: number;
};
export type UnitSettings = {
	name: string;
	metersPerUnit: number | null;
	customName?: string | null;
};
export type ModelSettings = {
	units: UnitSettings;
	absoluteTolerance: number;
	angleToleranceRadians: number;
	angleToleranceDegrees: number;
	relativeToleranceRatio: number;
	distanceDisplayPrecision: number;
};
export type DocumentSettings = {
	documentId: string;
	lifecycleInstanceId: string;
	settingsRevision: string;
	model?: ModelSettings | null;
	settings?: DocumentSettings | null;
	solverEnabled?: boolean;
	layout?: Partial<ModelSettings> | null;
	resolutionSource?: string;
	sourceDocumentId?: string | null;
	associatedRhinoDocumentId?: string | null;
	activeRhinoDocumentId?: string | null;
	contextMismatch?: boolean;
	diagnostics?: string[];
};
export type DocumentMetadata = {
	documentId: string;
	lifecycleInstanceId: string;
	kind: DocumentKind;
	name: string;
	path: string | null;
	isActive: boolean;
	isModified: boolean;
	isReadOnly?: boolean;
	stateToken: string;
	settings?: DocumentSettings | null;
};
export type DocumentTransactionState = {
	documentId: string | null;
	segmentId: string | null;
	epoch: number;
	state: "idle" | "active" | "abandoned";
	lifecycleInstanceId: string;
};
