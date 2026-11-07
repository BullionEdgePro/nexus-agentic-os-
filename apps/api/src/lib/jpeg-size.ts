/**
 * A JPEG's width and height, read from its frame header (7 Nov 2026, portal
 * listings): the server checks the size the portals need (800 × 600) from the
 * photo itself, never from what the browser claims. Baseline, extended and
 * progressive frames all carry it the same way. null when the bytes are not a
 * JPEG, or end before a frame header.
 */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    let marker = bytes[i + 1];
    while (marker === 0xff && i + 2 < bytes.length) {
      i += 1; // fill bytes before a marker
      marker = bytes[i + 1];
    }
    if (marker === 0xd9 || marker === 0xda) return null; // the image ended, or its data began, with no frame header
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2; // markers that stand alone
      continue;
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2) return null;
    const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (frame) {
      if (i + 8 >= bytes.length) return null;
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + length;
  }
  return null;
}
