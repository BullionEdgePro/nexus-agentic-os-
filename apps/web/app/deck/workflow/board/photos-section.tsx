"use client";

import type { BoardUnit } from "@nexus/shared";

/**
 * A unit's Photos section (7 Nov 2026): the photos in the order the portals
 * show them, the first marked as the cover, each movable earlier or later or
 * removed (after a confirm), and Add photos while there are fewer than 30.
 * Look-only shows the photos and nothing to change them with.
 * Spec: docs/superpowers/specs/2026-11-07-portal-listings-design.md §2.2, §8
 */

export const MAX_PHOTOS = 30;

export function PhotosSection({
  unit,
  canEdit,
  photoSrc,
  onAdd,
  onMove,
  onRemove,
}: {
  unit: BoardUnit;
  canEdit: boolean;
  photoSrc: (photoId: string) => string;
  onAdd: (files: File[]) => void;
  onMove: (photoId: string, by: -1 | 1) => void;
  onRemove: (photoId: string) => void;
}) {
  const photos = unit.photos;
  return (
    <section className="wf-window-part">
      <h3>Photos</h3>
      <p className="wf-board-empty">
        {photos.length} of {MAX_PHOTOS}. {photos.length > 0 ? "The first is the cover." : "The portals need at least 3."}
      </p>
      {photos.length > 0 ? (
        <ol className="wf-board-photos">
          {photos.map((p, i) => (
            <li key={p.id} className="wf-board-photo">
              <img src={photoSrc(p.id)} alt={`Photo ${i + 1} of ${photos.length}`} width={p.width} height={p.height} loading="lazy" />
              {i === 0 ? <span className="wf-board-cover">Cover</span> : null}
              {canEdit ? (
                <div className="wf-board-photo-actions">
                  <button type="button" className="kit-pill quiet" disabled={i === 0} onClick={() => onMove(p.id, -1)}>
                    Move earlier
                  </button>
                  <button type="button" className="kit-pill quiet" disabled={i === photos.length - 1} onClick={() => onMove(p.id, 1)}>
                    Move later
                  </button>
                  <button
                    type="button"
                    className="kit-pill quiet"
                    onClick={() => {
                      if (window.confirm("Remove this photo from the listing?")) onRemove(p.id);
                    }}
                  >
                    Remove
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {canEdit && photos.length < MAX_PHOTOS ? (
        <label className="btn wf-board-add-photos">
          Add photos
          <input
            type="file"
            accept="image/*"
            multiple
            className="wf-board-file"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              if (files.length > 0) onAdd(files);
            }}
          />
        </label>
      ) : null}
    </section>
  );
}
