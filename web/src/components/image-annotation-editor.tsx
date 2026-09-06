import { CaptureUpdateAction, Excalidraw, MainMenu, convertToExcalidrawElements, exportToBlob, newElementWith } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI, ExcalidrawInitialDataState, DataURL } from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/excalidraw/element/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { blobAttachment, imageUrl, type DraftImage } from "../lib/image-attachments";
import { MAX_IMAGE_BYTES } from "../../../src/host/protocol";
import { Button } from "./ui/button";

async function exportAttachment(options: Parameters<typeof exportToBlob>[0]) {
	let maxWidthOrHeight = 2048;
	while (true) {
		const blob = await exportToBlob({ ...options, maxWidthOrHeight });
		if (blob.size <= MAX_IMAGE_BYTES) return blobAttachment(blob);
		if (maxWidthOrHeight === 128) throw new Error("Could not fit the annotated image within 5 MB. Your drawing is still open.");
		maxWidthOrHeight = Math.max(128, Math.floor(maxWidthOrHeight * 0.75));
	}
}

export default function ImageAnnotationEditor({ attachment, onSave, onCancel }: {
	attachment?: DraftImage;
	onSave(image: DraftImage): void;
	onCancel(): void;
}) {
	const mounted = useRef(true);
	// A blank canvas should not jump or zoom when the user draws their first stroke.
	const fitted = useRef(!attachment);
	const [drawingId] = useState(() => crypto.randomUUID());
	useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
	const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const initialData = useMemo<ExcalidrawInitialDataState>(() => {
		if (attachment?.scene) return { ...structuredClone(attachment.scene), scrollToContent: true };
		if (!attachment?.original) return {
			elements: [], files: {},
			appState: {
				viewBackgroundColor: "#ffffff", currentItemStrokeColor: "#1e1e1e", currentItemStrokeWidth: 2, currentItemRoughness: 0,
				activeTool: { type: "freedraw", customType: null, lastActiveTool: null, locked: false },
			},
		};
		const fileId = attachment.id as FileId;
		const scale = Math.min(1, 1600 / Math.max(attachment.width, attachment.height));
		return {
			elements: convertToExcalidrawElements([{
				type: "image", x: 0, y: 0, fileId, locked: true,
				width: attachment.width * scale, height: attachment.height * scale,
				status: "saved",
			}]),
			files: { [fileId]: { id: fileId, mimeType: attachment.original.mimeType, dataURL: imageUrl(attachment.original) as DataURL, created: Date.now() } },
			appState: { viewBackgroundColor: "#ffffff", currentItemStrokeColor: "#e03131", currentItemStrokeWidth: 2, currentItemRoughness: 0 },
			scrollToContent: true,
		};
	}, [attachment]);
	const sourceImage = initialData.elements?.find((element) => element.type === "image" && element.fileId === attachment?.id);
	const [imageOpacity, setImageOpacity] = useState<number | null>(sourceImage?.opacity ?? null);

	const changeImageOpacity = (opacity: number) => {
		if (!api || saving || !sourceImage) return;
		api.updateScene({
			elements: api.getSceneElementsIncludingDeleted().map((element) =>
				element.id === sourceImage.id && !element.isDeleted ? newElementWith(element, { opacity }) : element),
			captureUpdate: CaptureUpdateAction.IMMEDIATELY,
		});
	};

	const save = async () => {
		if (!api || saving) return;
		setSaving(true);
		setError(null);
		try {
			const elements = api.getSceneElements();
			if (!elements.length) throw new Error("Draw something before saving.");
			const files = api.getFiles();
			const state = api.getAppState();
			const appState = {
				viewBackgroundColor: state.viewBackgroundColor, exportBackground: true, exportWithDarkMode: false,
				currentItemStrokeColor: state.currentItemStrokeColor, currentItemStrokeWidth: state.currentItemStrokeWidth,
				currentItemRoughness: state.currentItemRoughness, currentItemFontFamily: state.currentItemFontFamily,
				currentItemFontSize: state.currentItemFontSize,
			};
			const image = await exportAttachment({ elements, files, appState, mimeType: "image/png", exportPadding: 16 });
			if (!mounted.current) return;
			const scene = { elements: structuredClone(elements), files: { ...files }, appState };
			onSave(attachment ? { ...attachment, image, scene } : { id: drawingId, name: "Drawing.png", image, scene });
		} catch (cause) {
			if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not save the annotations. Try again.");
		} finally { if (mounted.current) setSaving(false); }
	};

	return <>
		<div className="min-h-0 flex-1 overflow-hidden rounded-sm border border-line">
			<Excalidraw initialData={initialData} excalidrawAPI={setApi} theme="light" autoFocus viewModeEnabled={saving}
				onChange={(elements, state) => {
					const image = elements.find((element) => element.id === sourceImage?.id && !element.isDeleted);
					setImageOpacity(image?.opacity ?? null);
					if (!api || fitted.current || state.isLoading || !elements.length) return;
					fitted.current = true;
					requestAnimationFrame(() => {
						if (mounted.current) api.scrollToContent(elements, { fitToViewport: true, viewportZoomFactor: 0.8, maxZoom: 1, animate: false });
					});
				}}
				UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, toggleTheme: false, saveAsImage: false }, tools: { image: false } }}
				validateEmbeddable={false}>
				<MainMenu><MainMenu.DefaultItems.ClearCanvas /><MainMenu.DefaultItems.ChangeCanvasBackground /></MainMenu>
			</Excalidraw>
		</div>
		{error && <p role="alert" className="text-sm text-danger">{error}</p>}
		<div className="flex flex-wrap items-center justify-end gap-3">
			{sourceImage && <label className="mr-auto flex items-center gap-2 text-sm">
				Image opacity
				<input type="range" min={0} max={100} step={1} value={imageOpacity ?? 100}
					aria-valuetext={imageOpacity === null ? "Image removed" : `${imageOpacity}%`}
					disabled={!api || saving || imageOpacity === null} className="w-28 accent-accent sm:w-40"
					onChange={(event) => changeImageOpacity(Number(event.target.value))} />
				<span className="w-10 text-right tabular-nums">{imageOpacity === null ? "—" : `${imageOpacity}%`}</span>
			</label>}
			<Button variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
			<Button onClick={() => void save()} disabled={!api || saving}>{saving ? "Saving…" : attachment?.original ? "Save annotations" : "Save drawing"}</Button>
		</div>
	</>;
}
