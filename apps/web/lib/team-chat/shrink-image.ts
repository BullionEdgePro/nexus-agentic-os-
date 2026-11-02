/**
 * Photos are shrunk on the sender's device before they are sent (2 Nov 2026),
 * as WhatsApp does: a phone photo is 3–8 MB and 4000 px across, and a chat
 * needs neither. The longest side becomes 1600 px at JPEG quality 0.82, plus a
 * 320 px preview the thread shows at once while the full photo loads.
 * Spec: docs/superpowers/specs/2026-11-02-staff-chat-whatsapp-design.md §3
 */

export const SHRINK = { longest: 1600, quality: 0.82, previewLongest: 320 } as const;

/** The size that fits within `longest` on its longer side, never enlarged. Pure. */
export function fitWithin(width: number, height: number, longest: number): { width: number; height: number } {
  const scale = Math.min(1, longest / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function decode(file: Blob): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(file);
  } catch {
    return null;
  }
}

function drawJpeg(image: ImageBitmap, longest: number, quality: number): Promise<{ blob: Blob; width: number; height: number } | null> {
  const size = fitWithin(image.width, image.height, longest);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) return Promise.resolve(null);
  // JPEG has no transparency: a PNG screenshot's clear areas become white, not black.
  context.fillStyle = "#FFFFFF";
  context.fillRect(0, 0, size.width, size.height);
  context.drawImage(image, 0, 0, size.width, size.height);
  return new Promise((resolve) =>
    canvas.toBlob((blob) => resolve(blob ? { blob, ...size } : null), "image/jpeg", quality)
  );
}

/**
 * The photo to send and its preview, or null when this browser cannot read the
 * picture (an old HEIC on a desktop, say) — the caller then offers it as a
 * document instead. A GIF is sent as it is, so it keeps moving.
 */
export async function shrinkImage(
  file: File
): Promise<{ blob: Blob; preview: Blob; width: number; height: number } | null> {
  const image = await decode(file);
  if (!image) return null;
  try {
    const preview = await drawJpeg(image, SHRINK.previewLongest, 0.7);
    if (!preview) return null;
    if (file.type === "image/gif") {
      return { blob: file, preview: preview.blob, width: image.width, height: image.height };
    }
    const full = await drawJpeg(image, SHRINK.longest, SHRINK.quality);
    if (!full) return null;
    return { blob: full.blob, preview: preview.blob, width: full.width, height: full.height };
  } finally {
    image.close();
  }
}
