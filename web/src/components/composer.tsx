import { ArrowUp, ImagePlus, Pencil, RefreshCw, Square, X } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { MAX_IMAGES } from "../../../src/host/protocol";
import { IMAGE_ACCEPT, imageUrl, readImage, type DraftImage } from "../lib/image-attachments";
import { ImageAnnotationDialog } from "./image-annotation-dialog";
import { cn } from "../lib/utils";
import type { SendMode } from "../state/hopper-types";
import { toolbarTriggerClass } from "./model-picker";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

const MAX_HEIGHT = 220;

const MODE_LABELS: Record<SendMode, string> = {
	follow_up: "Follow up after turn",
	steer: "Steer current turn",
	prompt: "New turn",
};

export type ComposerHandle = { focus(): void };

export type ComposerProps = {
	draft: string;
	images: DraftImage[];
	onImagesChange(images: DraftImage[]): void;
	imagesSupported: boolean;
	onDraftChange(value: string): void;
	mode: SendMode;
	onModeChange(mode: SendMode): void;
	disabled: boolean;
	streaming: boolean;
	onSubmit(): void;
	onAbort(): void;
	/** Toolbar controls rendered at the start of the bottom row (model, thinking). */
	controls?: ReactNode;
};

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
	{ draft, onDraftChange, images, onImagesChange, imagesSupported, mode, onModeChange, disabled, streaming, onSubmit, onAbort, controls },
	ref,
) {
	const fileInput = useRef<HTMLInputElement>(null);
	const replaceId = useRef<string | null>(null);
	const [editor, setEditor] = useState<{ kind: "new" } | { kind: "existing"; id: string } | null>(null);
	const [loading, setLoading] = useState(false);
	const [imageError, setImageError] = useState<string | null>(null);
	const currentImages = useRef(images);
	currentImages.current = images;
	const loadGeneration = useRef(0);
	useEffect(() => () => { loadGeneration.current++; }, []);
	const editing = editor?.kind === "existing" ? images.find((image) => image.id === editor.id) : undefined;
	const newDrawing = editor?.kind === "new";
	const addImages = async (files: File[], replacement: string | null = null) => {
		if (disabled || loading || !files.length) return;
		setImageError(null);
		if (!replacement && images.length + files.length > MAX_IMAGES) { setImageError(`Attach up to ${MAX_IMAGES} images.`); return; }
		setLoading(true);
		const generation = ++loadGeneration.current;
		try {
			const loaded = await Promise.all((replacement ? files.slice(0, 1) : files).map(readImage));
			if (generation !== loadGeneration.current) return;
			const latest = currentImages.current;
			onImagesChange(replacement ? latest.map((image) => image.id === replacement ? loaded[0] : image) : [...latest, ...loaded]);
		} catch (cause) { if (generation === loadGeneration.current) setImageError(cause instanceof Error ? cause.message : "Could not open this image."); }
		finally { if (generation === loadGeneration.current) setLoading(false); }
	};
	const textarea = useRef<HTMLTextAreaElement>(null);
	useImperativeHandle(ref, () => ({ focus: () => textarea.current?.focus() }), []);

	useLayoutEffect(() => {
		const node = textarea.current;
		if (!node) return;
		node.style.height = "auto";
		node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT)}px`;
		node.style.overflowY = node.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
	}, [draft]);

	const submit = (event?: FormEvent) => {
		event?.preventDefault();
		if (!canSend) return;
		onSubmit();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			submit();
		}
	};

	const canSend = !disabled && !loading && (draft.trim().length > 0 || images.length > 0) && (!images.length || imagesSupported);

	return (
		<footer className="shrink-0 px-4 pb-4 pt-1 sm:px-6">
			<form
				onSubmit={submit}
				onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
				onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); void addImages(Array.from(event.dataTransfer.files)); } }}
				className={cn(
					"mx-auto w-full max-w-[760px] rounded-md border border-line bg-surface transition-colors focus-within:border-accent/60",
					disabled && "opacity-70",
				)}
			>
				<input ref={fileInput} type="file" accept={IMAGE_ACCEPT} multiple={!replaceId.current} className="sr-only" tabIndex={-1} aria-label="Choose images" disabled={disabled || loading}
					onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; const replacement = replaceId.current; replaceId.current = null; void addImages(files, replacement); }} />
				{images.length > 0 && <div className="flex flex-wrap gap-2 px-3 pt-3" aria-label="Image attachments">
					{images.map((image) => <div key={image.id} className="w-36 overflow-hidden rounded-sm border border-line bg-panel">
						<button type="button" className="block w-full" disabled={disabled || loading} onClick={() => setEditor({ kind: "existing", id: image.id })} aria-label={`Annotate ${image.name}`}>
							<img src={imageUrl(image.image)} alt={image.name} className="h-20 w-full object-contain" />
						</button>
						<p className="truncate px-1.5 pt-1 text-[11px] text-muted" title={image.name}>{image.name}</p>
						<div className="flex items-center justify-between p-1">
							<Button type="button" variant="ghost" size="icon-sm" disabled={disabled || loading} onClick={() => setEditor({ kind: "existing", id: image.id })} aria-label={`Edit annotations on ${image.name}`} title="Annotate"><Pencil className="size-3.5" /></Button>
							<Button type="button" variant="ghost" size="icon-sm" disabled={disabled || loading} onClick={() => { replaceId.current = image.id; if (fileInput.current) { fileInput.current.multiple = false; fileInput.current.click(); } }} aria-label={`Replace ${image.name}`} title="Replace image"><RefreshCw className="size-3.5" /></Button>
							<Button type="button" variant="ghost" size="icon-sm" disabled={disabled || loading} onClick={() => onImagesChange(images.filter((item) => item.id !== image.id))} aria-label={`Remove ${image.name}`} title="Remove image"><X className="size-3.5" /></Button>
						</div>
					</div>)}
				</div>}
				{loading && <p role="status" className="px-3 pt-2 text-xs text-muted">Opening images…</p>}
				{imageError && <p role="alert" className="px-3 pt-2 text-xs text-danger">{imageError}</p>}
				{images.length > 0 && !imagesSupported && <p role="alert" className="px-3 pt-2 text-xs text-danger">Select a model that supports images to send these attachments.</p>}
				<label className="sr-only" htmlFor="composer-input">Message Hopper</label>
				<textarea
					id="composer-input"
					ref={textarea}
					rows={1}
					value={draft}
					disabled={disabled}
					autoComplete="off"
					onChange={(event) => onDraftChange(event.target.value)}
					onKeyDown={onKeyDown}
					onPaste={(event) => { const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/")); if (files.length) { event.preventDefault(); void addImages(files); } }}
					placeholder={disabled ? "Waiting for the Hopper host…" : "Ask Hopper…"}
					className="block max-h-[220px] w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-[14px] leading-6 outline-none placeholder:text-muted disabled:cursor-not-allowed"
				/>
				<div className="flex flex-wrap items-center gap-1 px-1.5 pb-1.5 pt-0.5">
					<Button type="button" variant="ghost" size="icon-sm" disabled={disabled || loading || images.length >= MAX_IMAGES} aria-label="Attach images" title="Attach images, or paste a screenshot" onClick={() => { replaceId.current = null; if (fileInput.current) { fileInput.current.multiple = true; fileInput.current.click(); } }}><ImagePlus className="size-4" /></Button>
					<Button type="button" variant="ghost" size="sm" disabled={disabled || loading || images.length >= MAX_IMAGES} aria-label="New drawing" title="Draw on a blank canvas" onClick={() => { setImageError(null); setEditor({ kind: "new" }); }}><Pencil className="size-3.5" />Draw</Button>
					{controls}
					{streaming && (
						<Select value={mode} onValueChange={(value) => onModeChange(value as SendMode)}>
							<SelectTrigger aria-label="Message delivery" className={toolbarTriggerClass}>
								<SelectValue>{MODE_LABELS[mode]}</SelectValue>
							</SelectTrigger>
							<SelectContent align="start">
								{(Object.keys(MODE_LABELS) as SendMode[]).map((value) => (
									<SelectItem key={value} value={value}>{MODE_LABELS[value]}</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
					<span className="flex-1" />
					{streaming && (
						<Button type="button" size="sm" variant="destructive" onClick={onAbort}>
							<Square className="size-3 fill-current" />
							Stop
						</Button>
					)}
					<Button type="submit" size="icon-sm" disabled={!canSend} aria-label="Send message" title="Send (Enter)">
						<ArrowUp className="size-4" />
					</Button>
				</div>
			</form>
			{(editing || newDrawing) && <ImageAnnotationDialog key={editing?.id ?? "new-drawing"} attachment={editing}
				onClose={() => setEditor(null)}
				onSave={(updated) => {
					const latest = currentImages.current;
					onImagesChange(newDrawing ? [...latest, updated] : latest.map((image) => image.id === updated.id ? updated : image));
					setEditor(null);
				}} />}
		</footer>
	);
});
