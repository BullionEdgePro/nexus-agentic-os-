import { forgetPushDevice } from "@/lib/api";

/**
 * Signing out forgets this phone (phone push review fix, 4 Nov 2026).
 *
 * Sign-out only cleared the cookie, so on a shared phone the last person's
 * alerts -- an admin's chats nobody has taken, message text and all -- kept
 * arriving for whoever signed in next. So, in order: ask the server to forget
 * this phone while the session still exists, unsubscribe it in the browser
 * (even if the server could not be reached: the next alert to it then comes
 * back "gone" and the server drops it), then sign out. Nothing here may hold
 * sign-out up, so every wait is bounded.
 *
 * The sign-out links keep their href, so they still work as plain links if
 * this handler never runs.
 */

const SIGN_OUT = "/api/auth/logout";

interface ThisPhone {
  endpoint: string;
  unsubscribe: () => Promise<boolean>;
}

export interface SignOutDeps {
  /** This browser's push subscription, or null when it has none. */
  subscription: () => Promise<ThisPhone | null>;
  /** Tell the server to forget the phone at this address. */
  forget: (endpoint: string) => Promise<unknown>;
  navigate: (url: string) => void;
  /** How long the server may take before sign-out goes ahead without it (ms). */
  wait?: number;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function forgetThisPhone(deps: SignOutDeps, wait: number): Promise<void> {
  const phone = await deps.subscription().catch(() => null);
  if (!phone) return;
  await Promise.race([deps.forget(phone.endpoint).catch(() => undefined), pause(wait)]);
  await phone.unsubscribe().catch(() => false);
}

export async function signOutThisBrowser(deps: SignOutDeps): Promise<void> {
  const wait = deps.wait ?? 2500;
  try {
    await Promise.race([forgetThisPhone(deps, wait), pause(wait * 2)]);
  } finally {
    deps.navigate(SIGN_OUT);
  }
}

/** The sign-out links' click handler. */
export function signOutHere(event: { preventDefault: () => void }): void {
  event.preventDefault();
  void signOutThisBrowser({
    subscription: async () => {
      // getRegistration, not ready: ready never settles where no service worker
      // was ever registered.
      const registration = await navigator.serviceWorker?.getRegistration();
      return (await registration?.pushManager?.getSubscription()) ?? null;
    },
    forget: (endpoint) => forgetPushDevice(endpoint),
    navigate: (url) => window.location.assign(url),
  });
}
