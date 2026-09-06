import { Component, lazy, Suspense, type ReactNode } from "react";
import type { DraftImage } from "../lib/image-attachments";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

const Editor = lazy(() => {
	// Excalidraw registers fonts during import, so configure local assets first.
	window.EXCALIDRAW_ASSET_PATH = "/excalidraw/";
	return import("./image-annotation-editor");
});

class EditorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	state = { failed: false };
	static getDerivedStateFromError() { return { failed: true }; }
	render() {
		return this.state.failed ? <p role="alert">The drawing editor could not load. Close it and try again.</p> : this.props.children;
	}
}

export function ImageAnnotationDialog({ attachment, onSave, onClose }: {
	attachment?: DraftImage;
	onSave(image: DraftImage): void;
	onClose(): void;
}) {
	return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
		<DialogContent className="h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[1400px] gap-3 overflow-hidden p-3 sm:p-4"
			onInteractOutside={(event) => event.preventDefault()} onEscapeKeyDown={(event) => event.preventDefault()}>
			<DialogHeader>
				<DialogTitle>{attachment?.original ? "Annotate image" : attachment ? "Edit drawing" : "New drawing"}</DialogTitle>
				<DialogDescription>Add arrows, shapes, text, or freehand marks. {attachment ? "Save to update the attachment." : "Save to attach your drawing to the message."}</DialogDescription>
			</DialogHeader>
			<EditorBoundary>
				<Suspense fallback={<p role="status" className="flex-1 p-6 text-muted">Loading drawing editor…</p>}>
					<Editor attachment={attachment} onSave={onSave} onCancel={onClose} />
				</Suspense>
			</EditorBoundary>
		</DialogContent>
	</Dialog>;
}
