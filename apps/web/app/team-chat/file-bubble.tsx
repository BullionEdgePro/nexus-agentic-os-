"use client";

import { useEffect, useState } from "react";
import { teamFileUrl, type TeamChatFile } from "@/lib/api";
import { formatClock } from "@/lib/team-chat/waveform";

/**
 * What a team chat message carries besides words (2 Nov 2026): a photo, a
 * file, or a voice note. Files are fetched with the session cookie into an
 * object URL — the API is on another origin, and a bare <img src> would not
 * carry the credentials the file needs.
 */
export function useFileBlob(threadId: string, id: string, preview = false, enabled = true): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let made: string | null = null;
    let cancelled = false;
    fetch(teamFileUrl(threadId, id, preview), { credentials: "include" })
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => {
        if (!blob || cancelled) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [threadId, id, preview, enabled]);
  return url;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "📕";
  if (["xls", "xlsx", "csv", "numbers"].includes(ext)) return "📊";
  if (["doc", "docx", "txt", "rtf", "pages", "odt"].includes(ext)) return "📝";
  if (["ppt", "pptx", "key"].includes(ext)) return "📽️";
  if (["zip", "rar", "7z"].includes(ext)) return "🗜️";
  if (["jpg", "jpeg", "png", "gif", "webp", "heic", "svg"].includes(ext)) return "🖼️";
  if (["mp3", "m4a", "wav", "ogg", "aac"].includes(ext)) return "🎵";
  if (["mp4", "mov", "webm"].includes(ext)) return "🎞️";
  return "📄";
}

/** Download a file under its own name. */
export async function downloadFile(threadId: string, file: TeamChatFile): Promise<void> {
  const response = await fetch(teamFileUrl(threadId, file.id), { credentials: "include" });
  if (!response.ok) throw new Error(`API ${response.status} on the file`);
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function Photo({ file, threadId, onOpen }: { file: TeamChatFile; threadId: string; onOpen?: () => void }) {
  const url = useFileBlob(threadId, file.id, true);
  const ratio = file.width && file.height ? `${file.width} / ${file.height}` : "4 / 3";
  return (
    <button type="button" className="tc-photo" style={{ aspectRatio: ratio }} onClick={onOpen} aria-label="Open photo">
      {url ? <img src={url} alt="" /> : null}
    </button>
  );
}

function FileCard({ file, threadId }: { file: TeamChatFile; threadId: string }) {
  const [failed, setFailed] = useState(false);
  const type = file.name.includes(".") ? file.name.split(".").pop()!.toUpperCase() : "FILE";
  return (
    <button
      type="button"
      className="tc-file"
      onClick={() => {
        setFailed(false);
        downloadFile(threadId, file).catch(() => setFailed(true));
      }}
      aria-label={`Download ${file.name}`}
    >
      <span className="tc-file-icon" aria-hidden="true">
        {fileIcon(file.name)}
      </span>
      <span className="tc-file-text">
        <b>{file.name}</b>
        <small>{failed ? "Could not download — tap to try again" : `${fileSize(file.size)} · ${type}`}</small>
      </span>
    </button>
  );
}

export function FileBubble({
  file,
  threadId,
  onOpenPhoto,
}: {
  file: TeamChatFile;
  threadId: string;
  onOpenPhoto?: (file: TeamChatFile) => void;
}) {
  if (file.kind === "photo") return <Photo file={file} threadId={threadId} onOpen={() => onOpenPhoto?.(file)} />;
  if (file.kind === "voice") {
    return (
      <span className="tc-voice-stub">
        🎤 Voice note {formatClock(file.durationMs ?? 0)}
      </span>
    );
  }
  return <FileCard file={file} threadId={threadId} />;
}
