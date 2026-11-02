"use client";

import { useEffect, useRef, useState } from "react";
import type { TeamChatFile } from "@/lib/api";
import { useFileBlob } from "./file-bubble";
import { downloadFile } from "./download";

/**
 * A photo full screen (2 Nov 2026): tap or wheel to zoom, drag to look around
 * when zoomed, ⬇ to download, ✕ or Escape to close.
 */
export function PhotoViewer({ threadId, file, onClose }: { threadId: string; file: TeamChatFile; onClose: () => void }) {
  const full = useFileBlob(threadId, file.id, false);
  const preview = useFileBlob(threadId, file.id, true);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [failed, setFailed] = useState(false);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const close = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const setScale = (next: number) => {
    const clamped = Math.min(4, Math.max(1, next));
    setZoom(clamped);
    if (clamped === 1) setOffset({ x: 0, y: 0 });
  };

  return (
    <div className="tc-viewer" role="dialog" aria-modal="true" aria-label="Photo">
      <div className="tc-viewer-bar">
        <button
          type="button"
          aria-label="Download photo"
          onClick={() => void downloadFile(threadId, file).catch(() => setFailed(true))}
        >
          ⬇
        </button>
        <button type="button" ref={close} aria-label="Close photo" onClick={onClose}>
          ✕
        </button>
      </div>
      {failed ? <p className="tc-viewer-note">The photo could not be downloaded.</p> : null}
      <div
        className="tc-viewer-stage"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        onWheel={(event) => setScale(zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15))}
        onPointerDown={(event) => {
          if (zoom === 1) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
        }}
        onPointerMove={(event) => {
          const from = drag.current;
          if (!from) return;
          setOffset({ x: from.ox + event.clientX - from.x, y: from.oy + event.clientY - from.y });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      >
        {full || preview ? (
          <img
            src={full ?? preview ?? undefined}
            alt=""
            draggable={false}
            onDoubleClick={() => setScale(zoom > 1 ? 1 : 2.2)}
            onClick={() => {
              if (zoom === 1) setScale(2.2);
            }}
            style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`, cursor: zoom > 1 ? "grab" : "zoom-in" }}
          />
        ) : (
          <p className="tc-viewer-note">Loading the photo…</p>
        )}
      </div>
    </div>
  );
}
