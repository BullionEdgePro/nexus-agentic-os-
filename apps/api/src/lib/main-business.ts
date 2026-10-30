import { getRedisConnection } from "../queue/queue.js";

/**
 * The one Meta business portfolio whose card pays for every staff member's
 * WhatsApp (30 Oct 2026).
 *
 * A card pays only for WhatsApp accounts inside its own portfolio. When a staff
 * member connects their number, Meta asks which business to put it in, and on
 * 28-29 Oct one landed in its own portfolio with no card (Keshav Arora's) and
 * refused every campaign. The owner names the main portfolio once, on Team; the
 * setup checklist marks anyone outside it, and Connections tells staff which to
 * pick and warns straight after a connect that went elsewhere. One platform-wide
 * value, since one card pays for all six businesses.
 */

export interface MainBusiness {
  id: string;
  /** The name Meta shows in its "choose a business" step, as the owner typed it. */
  name: string;
  setBy: string | null;
  at: string;
}

const KEY = "nexus:staff-main-business";

export async function getMainBusiness(): Promise<MainBusiness | null> {
  try {
    const raw = await getRedisConnection().get(KEY);
    return raw ? (JSON.parse(raw) as MainBusiness) : null;
  } catch {
    return null;
  }
}

export async function setMainBusiness(id: string, name: string, setBy: string | null): Promise<MainBusiness> {
  const value: MainBusiness = { id, name, setBy, at: new Date().toISOString() };
  await getRedisConnection().set(KEY, JSON.stringify(value));
  return value;
}

/** The sentence a staff member reads after connecting under another business. Exported for its test. */
export function wrongBusinessWarning(main: MainBusiness, connectedBusinessId: string | null): string | null {
  if (!connectedBusinessId || connectedBusinessId === main.id) return null;
  return (
    `Your number was connected under a different Meta business, so the company card cannot pay for its campaigns. ` +
    `On your phone open WhatsApp Business → Settings → Account → Business Platform and disconnect, then press ` +
    `Connect WhatsApp here again and choose “${main.name}” when Meta asks for the business.`
  );
}
