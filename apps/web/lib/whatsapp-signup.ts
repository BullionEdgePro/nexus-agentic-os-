/**
 * Meta's Embedded Signup window for a WhatsApp Business app number (Coexistence).
 *
 * Shared since 30 Oct 2026: a staff member opens it from Connections for their
 * own number, and the owner opens it from Team for a staff member's. Same
 * window, same three values back; the server files the number under whoever
 * the route names.
 */
// Meta's JS SDK, loaded once and only when somebody actually connects.
const FB_SDK_ID = "facebook-jssdk";
const FB_SDK_SRC = "https://connect.facebook.net/en_US/sdk.js";

interface FacebookSdk {
  init(params: { appId: string; version: string; cookie?: boolean; xfbml?: boolean }): void;
  login(
    callback: (response: { authResponse?: { code?: string } | null }) => void,
    options: Record<string, unknown>
  ): void;
}

type FbWindow = Window & { FB?: FacebookSdk; fbAsyncInit?: () => void };

/** Load and initialise the SDK, resolving the FB object once it is ready. */
function loadFacebookSdk(appId: string, version: string): Promise<FacebookSdk> {
  return new Promise((resolve, reject) => {
    const w = window as FbWindow;
    if (w.FB) {
      resolve(w.FB);
      return;
    }
    w.fbAsyncInit = () => {
      w.FB!.init({ appId, version, cookie: true, xfbml: false });
      resolve(w.FB!);
    };
    if (document.getElementById(FB_SDK_ID)) return; // already loading; fbAsyncInit resolves
    const script = document.createElement("script");
    script.id = FB_SDK_ID;
    script.src = FB_SDK_SRC;
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => reject(new SignupStopped("Could not load Meta's sign-in. Check your connection and try again."));
    document.body.appendChild(script);
  });
}

/**
 * Meta's window stopped without a code, in words for the person (5 Nov 2026).
 * Its own class so the screens show this sentence rather than readableError's
 * generic "could not be connected", which is what they did with a plain Error.
 */
export class SignupStopped extends Error {}

/**
 * Meta finished but handed back no code (5 Nov 2026). +971 58 848 3731 (SFS)
 * ended this way: connected at Meta, its customers' messages arriving, and no
 * person in Nexus holding it — because this file called it "cancelled" and sent
 * nothing. Connecting again takes Meta's "Continue" path, which does return one.
 */
const FINISHED_WITHOUT_CODE =
  "Meta finished connecting your number but did not hand Nexus its key, so it is not saved and its messages reach nobody. " +
  "Press Connect WhatsApp again and choose Continue — the number is already set up, so it takes a few seconds.";

/**
 * Run Embedded Signup and return the three things the server needs.
 *
 * The `code` comes from the login callback; the WABA and phone-number ids arrive
 * separately as a window message from Meta's popup, so both are captured and only
 * a run that produced all three is treated as a success. `featureType` is the
 * coexistence variant: the number stays on the staff member's WhatsApp Business
 * app and is ALSO connected here. The config id decides the rest of the flow at
 * Meta's end.
 */
export async function launchWhatsAppSignup(provider: {
  appId?: string | null;
  configId?: string | null;
  graphVersion?: string | null;
}): Promise<{
  code: string;
  wabaId?: string;
  phoneNumberId?: string;
}> {
  if (!provider.appId || !provider.configId) {
    throw new SignupStopped("WhatsApp connecting is not enabled on this server yet.");
  }
  const FB = await loadFacebookSdk(provider.appId, provider.graphVersion ?? "v21.0");

  return new Promise((resolve, reject) => {
    let captured: { wabaId?: string; phoneNumberId?: string } = {};
    let finished = false;
    // Set while a run with no code waits to hear whether Meta finished.
    let decideWithoutCode: (() => void) | null = null;
    const onMessage = (event: MessageEvent) => {
      if (!/(^|\.)facebook\.com$/.test(new URL(event.origin).hostname)) return;
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (data?.type === "WA_EMBEDDED_SIGNUP" && data?.data) {
          // FINISH, FINISH_ONLY_WABA, FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING:
          // the number is connected at Meta. CANCEL and ERROR carry no ids.
          if (typeof data.event === "string" && data.event.startsWith("FINISH")) {
            finished = true;
            decideWithoutCode?.();
          }
          if (data.data.phone_number_id) {
            captured = { wabaId: data.data.waba_id, phoneNumberId: data.data.phone_number_id };
          }
        }
      } catch {
        // Not our message; ignore.
      }
    };
    window.addEventListener("message", onMessage);

    FB.login(
      (response) => {
        const code = response?.authResponse?.code;
        if (!code) {
          // Meta's FINISH can arrive a moment after this callback (review, 5 Nov
          // 2026), so a run with no code waits briefly to hear it before saying
          // "cancelled" about a number that is in fact connected.
          let wait: ReturnType<typeof setTimeout> | undefined;
          decideWithoutCode = () => {
            decideWithoutCode = null;
            if (wait) clearTimeout(wait);
            window.removeEventListener("message", onMessage);
            reject(new SignupStopped(finished ? FINISHED_WITHOUT_CODE : "WhatsApp sign-in was cancelled."));
          };
          if (finished) decideWithoutCode();
          else wait = setTimeout(() => decideWithoutCode?.(), 1500);
          return;
        }
        window.removeEventListener("message", onMessage);
        // The waba/phone ids are a fast path, not a requirement. Meta only sends
        // them (as the window message above) on the full flow; the "Continue with
        // previous settings" path returns just the code. Either way the server
        // derives the number from the token, so pass through whatever we captured.
        resolve({ code, wabaId: captured.wabaId, phoneNumberId: captured.phoneNumberId });
      },
      {
        config_id: provider.configId,
        response_type: "code",
        override_default_response_type: true,
        // COEXISTENCE: the staff member keeps the number on the WhatsApp Business
        // app on their phone AND it joins the Cloud API, so chats show in both.
        // (2026-09-25) Dedicated new numbers moved to the Team screen, which
        // registers them on the business's own account without Embedded Signup,
        // so this button is only for bringing an EXISTING Business-app number.
        // The 2026-09-22 switch to standard onboarding was based on a wrong
        // diagnosis: both modes hit "can't onboard customers at the moment",
        // because the app's Tech Provider terms can't be saved (Meta server error
        // 1675030 on xfb_accept_whatsapp_business_partner_terms_of_service, ticket
        // 2073119380011659). Until Meta fixes that, this still shows that message.
        extras: { setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" },
      }
    );
  });
}
