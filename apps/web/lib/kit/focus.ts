/**
 * Keeping keyboard focus inside an open window or panel (2 Nov 2026, Cream
 * pages 2a): Tab from the last control goes to the first, Shift+Tab from the
 * first to the last. `nextFocus` is pure; `focusables` reads the DOM.
 */
const SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(SELECTOR)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  );
}

export function nextFocus<T>(list: T[], current: T | null, back: boolean): T {
  const at = current === null ? -1 : list.indexOf(current);
  if (at === -1) return back ? list[list.length - 1]! : list[0]!;
  return list[(at + (back ? -1 : 1) + list.length) % list.length]!;
}

/** Traps Tab inside `root`; returns true when it handled the key. */
export function trapTab(root: HTMLElement, event: KeyboardEvent): boolean {
  if (event.key !== "Tab") return false;
  const list = focusables(root);
  if (list.length === 0) return false;
  const current = list.includes(document.activeElement as HTMLElement) ? (document.activeElement as HTMLElement) : null;
  event.preventDefault();
  nextFocus(list, current, event.shiftKey).focus();
  return true;
}
