import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { MAX_IMAGE_BYTES, parseImages, type ImageAttachment } from "../../../src/host/protocol";

export type AnnotationScene = {
	elements: readonly ExcalidrawElement[];
	files: BinaryFiles;
	appState: Partial<AppState>;
};

export type DraftImage = {
	id: string;
	name: string;
	image: ImageAttachment;
	scene?: AnnotationScene;
} & ({ original: ImageAttachment; width: number; height: number } | { original?: never; scene: AnnotationScene });

export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
export const imageUrl = (image: ImageAttachment) => `data:${image.mimeType};base64,${image.data}`;

export function readDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(new Error("Could not read this image."));
		reader.readAsDataURL(blob);
	});
}

export async function blobAttachment(blob: Blob): Promise<ImageAttachment> {
	const url = await readDataUrl(blob);
	return parseImages([{ type: "image", mimeType: blob.type, data: url.slice(url.indexOf(",") + 1) }])![0];
}

export async function readImage(file: File): Promise<DraftImage> {
	if (!IMAGE_ACCEPT.split(",").includes(file.type)) throw new Error("Use PNG, JPEG, WebP, or GIF images.");
	if (!file.size || file.size > MAX_IMAGE_BYTES) throw new Error("Choose an image smaller than 5 MB.");
	const image = await blobAttachment(file);
	const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
		const element = new Image();
		element.onload = () => resolve({ width: element.naturalWidth, height: element.naturalHeight });
		element.onerror = () => reject(new Error("This image could not be opened. Try another file."));
		element.src = imageUrl(image);
	});
	return { id: crypto.randomUUID(), name: file.name || "Pasted image", ...dimensions, image, original: image };
}
