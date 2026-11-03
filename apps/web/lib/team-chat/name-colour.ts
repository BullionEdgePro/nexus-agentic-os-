/**
 * Which of the eight name colours a colleague takes in a group chat (2 Nov
 * 2026), as WhatsApp colours each member's name. Chosen from the employee id
 * by FNV-1a, so the same person is the same colour on every screen and every
 * day, with no setting to store. The colours themselves are --tc-name-0…7 in
 * team-chat.css, each checked to read on the bubble in both themes. Pure.
 */
export const NAME_COLOURS = 8;

export function nameColourIndex(employeeId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < employeeId.length; i += 1) {
    hash ^= employeeId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % NAME_COLOURS;
}
