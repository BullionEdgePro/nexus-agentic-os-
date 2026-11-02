import type { TeamFileKind } from "@nexus/db";

/**
 * What a team chat upload really is, and how it may be served (2 Nov 2026).
 * Spec: docs/superpowers/specs/2026-11-02-staff-chat-whatsapp-design.md §3, §5
 *
 * A browser says what a file is by its name and a type it guesses from the
 * name. Neither is evidence: "invoice.pdf" can be a web page, and a web page
 * served from the API's origin runs with the API's cookies. So the type is
 * read from the first bytes, only real photos and voice notes are ever shown
 * inside the browser, and everything else is handed over as a download in a
 * sandbox. Pure, so every rule is tested with real bytes.
 */

export const TEAM_LIMITS = {
  photoBytes: 5 * 1024 * 1024,
  previewBytes: 200 * 1024,
  fileBytes: 16 * 1024 * 1024,
  voiceBytes: 6 * 1024 * 1024,
  requestBytes: 17 * 1024 * 1024,
  voiceMinMs: 1000,
  voiceMaxMs: 305_000,
  waveformMax: 128,
  bodyMax: 4000,
} as const;

type Sniffed = "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "audio/mp4" | "audio/webm" | "audio/ogg";

const IMAGE_TYPES = new Set<string>(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const AUDIO_TYPES = new Set<string>(["audio/mp4", "audio/webm", "audio/ogg"]);

const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));

/** The type the first bytes prove, or null when they prove none of the types we show. */
export function sniff(bytes: Uint8Array): Sniffed | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return "image/png";
  const head = ascii(bytes, 0, 6);
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (ascii(bytes, 4, 8) === "ftyp") return "audio/mp4";
  if ([0x1a, 0x45, 0xdf, 0xa3].every((b, i) => bytes[i] === b)) return "audio/webm";
  if (ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
  return null;
}

function int(value: unknown, min: number, max: number): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function waveformOf(value: unknown): number[] | null {
  let list = value;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(list) || list.length === 0 || list.length > TEAM_LIMITS.waveformMax) return null;
  return list.every((v) => Number.isInteger(v) && v >= 0 && v <= 100) ? (list as number[]) : null;
}

export type UploadCheck =
  | {
      ok: true;
      kind: TeamFileKind;
      mime: string;
      durationMs: number | null;
      waveform: number[] | null;
      width: number | null;
      height: number | null;
    }
  | { ok: false; error: string };

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** Whether an upload is what it says it is, within the limits. */
export function checkUpload(input: {
  kind: string;
  bytes: Uint8Array;
  preview: Uint8Array | null;
  durationMs?: unknown;
  waveform?: unknown;
  width?: unknown;
  height?: unknown;
}): UploadCheck {
  const { bytes } = input;
  if (bytes.length === 0) return { ok: false, error: "That file is empty." };
  const sniffed = sniff(bytes);

  if (input.kind === "photo") {
    if (!sniffed || !IMAGE_TYPES.has(sniffed)) return { ok: false, error: "That is not a photo Nexus can show. Send it as a document." };
    if (bytes.length > TEAM_LIMITS.photoBytes) return { ok: false, error: `Photos can be up to ${mb(TEAM_LIMITS.photoBytes)}.` };
    if (input.preview && (sniff(input.preview) !== "image/jpeg" || input.preview.length > TEAM_LIMITS.previewBytes)) {
      return { ok: false, error: "The photo's preview could not be read. Try sending it again." };
    }
    return {
      ok: true,
      kind: "photo",
      mime: sniffed,
      durationMs: null,
      waveform: null,
      width: int(input.width, 1, 20000),
      height: int(input.height, 1, 20000),
    };
  }

  if (input.kind === "voice") {
    if (!sniffed || !AUDIO_TYPES.has(sniffed)) return { ok: false, error: "That recording could not be read. Record it again." };
    if (bytes.length > TEAM_LIMITS.voiceBytes) return { ok: false, error: "That voice note is too large. Keep it under 5 minutes." };
    const durationMs = int(input.durationMs, TEAM_LIMITS.voiceMinMs, TEAM_LIMITS.voiceMaxMs);
    if (durationMs === null) return { ok: false, error: "Voice notes are 1 second to 5 minutes long." };
    const waveform = waveformOf(input.waveform);
    if (!waveform) return { ok: false, error: "That recording could not be read. Record it again." };
    return { ok: true, kind: "voice", mime: sniffed, durationMs, waveform, width: null, height: null };
  }

  if (input.kind === "file") {
    if (bytes.length > TEAM_LIMITS.fileBytes) return { ok: false, error: `Files can be up to ${mb(TEAM_LIMITS.fileBytes)}.` };
    return {
      ok: true,
      kind: "file",
      mime: sniffed ?? "application/octet-stream",
      durationMs: null,
      waveform: null,
      width: null,
      height: null,
    };
  }

  return { ok: false, error: "Send a voice note, a photo or a file." };
}

/** A file name as stored: its last path part, no control characters, 200 characters at most. */
export function cleanName(raw: unknown): string {
  const last = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  const clean = [...last.replace(/\p{Cc}/gu, "").trim()].slice(0, 200).join("").trim();
  return clean && clean !== "." && clean !== ".." ? clean : "file";
}

/** RFC 5987: percent-encode everything outside attr-char, including ' ( ) *. */
const rfc5987 = (name: string) =>
  encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The plain filename="" fallback: printable ASCII only, no quotes or backslashes. */
const asciiName = (name: string) => name.replace(/[^\x20-\x7e]|["\\]/g, "_");

/** The headers a file is served with. Only real photos and voice notes open inline. */
export function servedHeaders(meta: { kind: TeamFileKind; mime: string; name: string }): Record<string, string> {
  const inline =
    (meta.kind === "photo" && IMAGE_TYPES.has(meta.mime)) || (meta.kind === "voice" && AUDIO_TYPES.has(meta.mime));
  const disposition = `${inline ? "inline" : "attachment"}; filename="${asciiName(meta.name)}"; filename*=UTF-8''${rfc5987(meta.name)}`;
  return {
    "Content-Type": inline ? meta.mime : "application/octet-stream",
    "Content-Disposition": disposition,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox",
    "Cache-Control": "private, max-age=31536000, immutable",
  };
}

const KEYCAP = /[0-9#*]\uFE0F?\u20E3/gu;

/** One emoji (with its modifiers, flags and keycaps), never words or markup. */
export function isEmoji(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 16) return false;
  const hadKeycap = KEYCAP.test(value);
  KEYCAP.lastIndex = 0;
  const rest = value.replace(KEYCAP, "");
  if (/[\p{L}\p{N}\s<>]/u.test(rest)) return false;
  return hadKeycap || /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]/u.test(rest);
}
