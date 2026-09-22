/**
 * The pure half of pasted-image handling: which clipboard formats become prompt images, and
 * the byte/name conversion the composer column needs. Kept out of `main.ts` so the chunking
 * and naming rules can be tested without a DOM - `main.ts` only wires events to these.
 */

import type { AttachmentView } from "../src/shared/protocol";

/** Formats omp takes as prompt image parts; every other paste stays an ordinary paste. */
export const IMAGE_MIME_TYPES: Record<string, true> = {
	"image/png": true,
	"image/jpeg": true,
	"image/webp": true,
	"image/gif": true,
	"image/bmp": true,
};

/** Chip label for an image that arrived without a filename of its own. */
export function imageName(mimeType: string, index: number): string {
	const extension = mimeType === "image/jpeg" ? "jpg" : (mimeType.split("/")[1] ?? "png");
	return `粘贴图片 ${index + 1}.${extension}`;
}

/** Bytes -> base64 for the bridge. Chunked: one spread over a screenshot overflows the stack. */
export function toBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let at = 0; at < bytes.length; at += chunk) {
		binary += String.fromCharCode(...bytes.subarray(at, at + chunk));
	}
	return btoa(binary);
}

/**
 * The composer attachment a pasted image becomes. Chromium labels a pasted bitmap
 * `image.png`; a filename that came off a real file is kept, so both a screenshot and a
 * copied file show something the user can recognise.
 */
export function pastedAttachment(
	file: { readonly name: string; readonly type: string },
	bytes: Uint8Array,
	index: number,
): AttachmentView {
	const generic = `image.${file.type.split("/")[1] ?? ""}`;
	return {
		name: file.name && file.name !== generic ? file.name : imageName(file.type, index),
		data: toBase64(bytes),
		mimeType: file.type,
	};
}
