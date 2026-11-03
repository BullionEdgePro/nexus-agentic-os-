/**
 * Where a business sits on the storefront's switchboard (app/landing.tsx).
 *
 * The ring is drawn 1.2× wider than it is tall, which suits a wide plate and
 * pushed the side cards half off a phone's: on a 343 px plate their centres
 * landed 148 px out, under cards 116 px wide. Each card's centre is now held
 * far enough in for the whole card to show; a wide plate never reaches the
 * limit, so its ring is drawn exactly as before.
 */
export function placeNode(angDeg: number, bw: number, bh: number, cardW: number, pad = 8): { x: number; y: number } {
  const R = Math.min(bw, bh) * 0.36;
  const a = (angDeg * Math.PI) / 180;
  const half = cardW / 2 + pad;
  const x = Math.min(Math.max(bw / 2 + Math.cos(a) * R * 1.2, half), bw - half);
  return { x, y: bh / 2 + Math.sin(a) * R };
}
