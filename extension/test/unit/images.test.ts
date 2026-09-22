import { describe, expect, it } from "vitest";
import { IMAGE_MIME_TYPES, imageName, pastedAttachment, toBase64 } from "../../webview/images";

/** Independent decode, so a truncated or mis-ordered chunk cannot pass by construction. */
const decoded = (base64: string): number[] => [...Buffer.from(base64, "base64")];

describe("pasted image helpers", () => {
	it("encodes past the chunk boundary without losing or reordering bytes", () => {
		const bytes = Uint8Array.from({ length: 0x8000 * 2 + 7 }, (_, at) => at % 256);
		expect(decoded(toBase64(bytes))).toEqual([...bytes]);
	});

	it("encodes one byte and a chunk exactly", () => {
		expect(decoded(toBase64(Uint8Array.of(255)))).toEqual([255]);
		expect(decoded(toBase64(Uint8Array.from({ length: 0x8000 }, () => 0xff)))).toHaveLength(0x8000);
	});

	it("keeps a filename that came off a real file", () => {
		const attachment = pastedAttachment({ name: "shot.png", type: "image/png" }, Uint8Array.of(1, 2), 0);
		expect(attachment).toEqual({ name: "shot.png", data: "AQI=", mimeType: "image/png" });
	});

	it("renames Chromium's generic pasted bitmap, keeping the index", () => {
		expect(pastedAttachment({ name: "image.png", type: "image/png" }, Uint8Array.of(1), 2).name).toBe("粘贴图片 3.png");
		expect(pastedAttachment({ name: "", type: "image/jpeg" }, Uint8Array.of(1), 0).name).toBe("粘贴图片 1.jpg");
		expect(imageName("image/webp", 1)).toBe("粘贴图片 2.webp");
	});

	it("admits the formats omp takes as prompt images and nothing else", () => {
		for (const mime of ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"]) {
			expect(IMAGE_MIME_TYPES[mime]).toBe(true);
		}
		// A pasted SVG or plain text must stay an ordinary paste.
		expect(IMAGE_MIME_TYPES["image/svg+xml"]).toBeUndefined();
		expect(IMAGE_MIME_TYPES["text/plain"]).toBeUndefined();
	});
});
