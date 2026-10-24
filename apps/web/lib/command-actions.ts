"use client";

import { useSyncExternalStore } from "react";

/**
 * Actions the open screen offers the command bar (24 Oct 2026, Focus
 * workspace). The inbox registers "For this chat · Feroz": draft a reply,
 * resolve, snooze, ask a colleague, not a customer. Ctrl+K lists them first.
 *
 * One registration at a time: the screen that sets them clears them when it
 * leaves, so the bar never offers an action for a chat that is not open.
 */
export interface CommandAction {
  id: string;
  label: string;
  /** A second line, e.g. what the action will do. */
  sub?: string;
  /** The key that does the same from the screen, shown beside it. */
  shortcut?: string;
  run: () => void;
}

interface Registration {
  title: string;
  actions: CommandAction[];
}

let current: Registration | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function setCommandActions(title: string, actions: CommandAction[]): void {
  current = { title, actions };
  emit();
}

export function clearCommandActions(): void {
  if (current === null) return;
  current = null;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCommandActions(): Registration | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null
  );
}
