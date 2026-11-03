"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PendingFile } from "@/lib/use-team-thread";
import { shrinkImage } from "@/lib/team-chat/shrink-image";
import { fileIcon, fileSize } from "./file-bubble";

/**
 * Photos and files in team chat (2 Nov 2026): the 📎 menu (camera, photos,
 * document), the preview with a caption before anything is sent, and dropping
 * or pasting files onto the chat on a computer.
 * Spec: docs/superpowers/specs/2026-11-02-staff-chat-whatsapp-design.md §3
 *
 * Photos are shrunk here, on the sender's device, before they leave it. A
 * picture this browser cannot read (an old HEIC on a desktop) is offered as a
 * document instead, and anything over a limit is named on the preview, before
 * Send — never as an error after a long upload.
 */

const PHOTO_MAX = 5 * 1024 * 1024;
const FILE_MAX = 16 * 1024 * 1024;

export type ReadyFile = Omit<PendingFile, "progress">;

const asJpegName = (name: string) => `${name.replace(/\.[^.]+$/, "") || "photo"}.jpg`;

/** What can be sent, and why anything else cannot — decided before sending. */
export async function prepareFiles(files: File[]): Promise<{ ready: ReadyFile[]; refused: string[] }> {
  const ready: ReadyFile[] = [];
  const refused: string[] = [];
  for (const file of files) {
    if (file.size === 0) {
      refused.push(`${file.name} is empty.`);
      continue;
    }
    if (file.type.startsWith("image/") && file.type !== "image/svg+xml") {
      const shrunk = await shrinkImage(file);
      if (shrunk) {
        if (shrunk.blob.size > PHOTO_MAX) {
          refused.push(`${file.name} is too large to send as a photo (5 MB at most).`);
        } else {
          ready.push({
            kind: "photo",
            blob: shrunk.blob,
            name: file.type === "image/gif" ? file.name : asJpegName(file.name),
            preview: shrunk.preview,
            width: shrunk.width,
            height: shrunk.height,
          });
        }
        continue;
      }
      // This browser cannot read the picture: it goes as a document.
    }
    if (file.size > FILE_MAX) {
      refused.push(`${file.name} is ${fileSize(file.size)} — files can be up to 16 MB.`);
      continue;
    }
    ready.push({ kind: "file", blob: file, name: file.name });
  }
  return { ready, refused };
}

const filesOf = (list: FileList | null | undefined) => (list ? Array.from(list) : []);

/** The 📎 button and its menu. */
export function AttachButton({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const camera = useRef<HTMLInputElement | null>(null);
  const photos = useRef<HTMLInputElement | null>(null);
  const documents = useRef<HTMLInputElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof PointerEvent && root.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const choose = (input: HTMLInputElement | null) => {
    setOpen(false);
    input?.click();
  };
  const take = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = filesOf(event.target.files);
    event.target.value = "";
    if (files.length) onFiles(files);
  };

  return (
    <div className="tc-attach" ref={root}>
      <button
        type="button"
        className="tc-icon-btn"
        aria-label="Attach"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        📎
      </button>
      {open ? (
        <div className="tc-attach-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => choose(camera.current)}>
            <span aria-hidden="true">📷</span> Camera
          </button>
          <button type="button" role="menuitem" onClick={() => choose(photos.current)}>
            <span aria-hidden="true">🖼</span> Photos
          </button>
          <button type="button" role="menuitem" onClick={() => choose(documents.current)}>
            <span aria-hidden="true">📄</span> Document
          </button>
        </div>
      ) : null}
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={take} />
      <input ref={photos} type="file" accept="image/*" multiple hidden onChange={take} />
      <input ref={documents} type="file" multiple hidden onChange={take} />
    </div>
  );
}

/**
 * Files dropped or pasted onto the chat. The handlers sit on the message box and,
 * once mounted, on the whole open chat around it, so a file dropped anywhere on
 * the conversation is caught.
 */
export function DropZone({ onFiles, children }: { onFiles: (files: File[]) => void; children: ReactNode }) {
  const root = useRef<HTMLDivElement | null>(null);
  const [over, setOver] = useState(false);
  const latest = useRef(onFiles);
  latest.current = onFiles;

  useEffect(() => {
    const area = root.current?.closest<HTMLElement>(".tc-thread, .ibx-dock");
    if (!area) return;
    const onOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      setOver(true);
    };
    const onLeave = (event: DragEvent) => {
      if (!area.contains(event.relatedTarget as Node | null)) setOver(false);
    };
    const onDropHere = (event: DragEvent) => {
      const files = filesOf(event.dataTransfer?.files);
      if (!files.length) return;
      event.preventDefault();
      setOver(false);
      latest.current(files);
    };
    area.addEventListener("dragover", onOver);
    area.addEventListener("dragleave", onLeave);
    area.addEventListener("drop", onDropHere);
    return () => {
      area.removeEventListener("dragover", onOver);
      area.removeEventListener("dragleave", onLeave);
      area.removeEventListener("drop", onDropHere);
    };
  }, []);

  return (
    <div
      ref={root}
      className={`tc-dropzone${over ? " over" : ""}`}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        const files = filesOf(event.dataTransfer.files);
        if (!files.length) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        onFiles(files);
      }}
      onPaste={(event) => {
        // A screenshot pasted into the box: send it as a photo, not as text.
        const files = filesOf(event.clipboardData.files);
        if (!files.length) return;
        event.preventDefault();
        onFiles(files);
      }}
    >
      {over ? <div className="tc-drop-hint">Drop to send</div> : null}
      {children}
    </div>
  );
}

function Thumb({ item }: { item: ReadyFile }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (item.kind !== "photo" || !item.preview) return;
    const made = URL.createObjectURL(item.preview);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [item]);
  if (item.kind === "photo") return <span className="tc-sheet-thumb">{url ? <img src={url} alt="" /> : null}</span>;
  return (
    <span className="tc-sheet-thumb doc" title={item.name}>
      <span aria-hidden="true">{fileIcon(item.name)}</span>
      <small>{item.name}</small>
    </span>
  );
}

/** The preview before sending: what goes, what cannot, and a caption. */
export function AttachSheet({
  files,
  onSend,
  onClose,
}: {
  files: File[];
  onSend: (ready: ReadyFile[], caption: string) => void;
  onClose: () => void;
}) {
  const [prepared, setPrepared] = useState<{ ready: ReadyFile[]; refused: string[] } | null>(null);
  const [caption, setCaption] = useState("");

  useEffect(() => {
    let current = true;
    void prepareFiles(files).then((result) => {
      if (current) setPrepared(result);
    });
    return () => {
      current = false;
    };
  }, [files]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const count = prepared?.ready.length ?? 0;
  return (
    <div className="tc-sheet" role="dialog" aria-label="Send photos and files">
      <header>
        <button type="button" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <b>{prepared ? (count === 1 ? "1 to send" : `${count} to send`) : "Getting them ready…"}</b>
      </header>
      <div className="tc-sheet-items">
        {prepared?.ready.map((item, index) => (
          <figure key={index}>
            <Thumb item={item} />
            <figcaption>{item.kind === "photo" ? "Photo" : fileSize(item.blob.size)}</figcaption>
          </figure>
        ))}
      </div>
      {prepared?.refused.length ? (
        <ul className="tc-sheet-refused" role="alert">
          {prepared.refused.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
      <form
        className="tc-sheet-send"
        onSubmit={(event) => {
          event.preventDefault();
          if (prepared && count > 0) onSend(prepared.ready, caption);
        }}
      >
        <input
          value={caption}
          onChange={(event) => setCaption(event.target.value)}
          placeholder="Add a caption"
          aria-label="Caption"
          maxLength={4000}
          autoFocus
        />
        <button type="submit" className="tc-round" aria-label="Send" disabled={!prepared || count === 0}>
          ➤
        </button>
      </form>
    </div>
  );
}
