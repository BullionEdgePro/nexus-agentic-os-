import { readableError } from "./api";
import { create } from "zustand";
import type {
  BusinessSlug,
  ConversationSummary,
  InboxSettings,
  MessageDto,
  TimelineItem,
} from "@nexus/shared";
import * as api from "./api";

/** Until a business's own settings arrive — the same defaults the API applies. */
export const DEFAULT_INBOX_SETTINGS: InboxSettings = {
  stages: ["New", "Contacted", "Qualified", "Proposal", "Won", "Lost"],
  slaMinutes: 180,
  isDefault: true,
  autoAssign: false,
};

/** Newest activity first — the order the API serves and the list must keep. */
function byActivity(a: ConversationSummary, b: ConversationSummary): number {
  return (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? "");
}

interface InboxState {
  selectedOrg: BusinessSlug;
  selectedConversationId: string | null;
  conversations: ConversationSummary[];
  messagesByConversation: Record<string, MessageDto[]>;
  /** What happened to each thread (assignments, resolves, handoffs, calls). */
  timelineByConversation: Record<string, TimelineItem[]>;
  /** The selected business's pipeline stages and reply-time target. */
  inboxSettings: InboxSettings;
  isLoadingConversations: boolean;
  isLoadingMessages: boolean;
  /**
   * A LOAD THAT FAILED, WHICH THIS STORE USED TO SWALLOW ENTIRELY.
   *
   * `loadConversations` had `try/finally` and no catch, so a failed request
   * rejected into an effect nobody was listening to and the list stayed empty.
   * On this screen that renders as "No conversations yet for this business" —
   * which is exactly what a quiet day looks like, on the one page a person opens
   * to find out whether any customer is waiting for them.
   */
  loadError: string;
  /**
   * A SEND (or another action on the open thread) that failed. Kept separate
   * because the consequence is different: the thread on screen is still
   * correct, and what needs saying is that the action did not happen.
   */
  sendError: string;

  /**
   * WHETHER THE LIVE FEED IS ACTUALLY LIVE. `closed` = down and retrying; `open`
   * = connected; `off` = no socket configured (not a fault); `connecting` = the
   * first attempt.
   */
  socketStatus: "connecting" | "open" | "closed" | "off";
  setSocketStatus: (status: "connecting" | "open" | "closed" | "off") => void;

  setSelectedOrg: (org: BusinessSlug) => void;
  selectConversation: (conversationId: string) => void;
  /** Leave the open thread — the phone layout's way back to the list. */
  closeConversation: () => void;
  loadConversations: () => Promise<void>;
  loadInboxSettings: () => Promise<void>;
  setInboxSettings: (settings: InboxSettings) => void;
  loadMessages: (conversationId: string) => Promise<void>;
  appendMessage: (conversationId: string, message: MessageDto) => void;
  sendMessage: (conversationId: string, text: string) => Promise<void>;
  setHumanHandoff: (conversationId: string, isHumanHandoff: boolean) => Promise<void>;
  applyHandoffChange: (conversationId: string, isHumanHandoff: boolean) => void;
  setStatus: (conversationId: string, status: "resolved" | "open") => Promise<void>;
  applyStatusChange: (conversationId: string, status: ConversationSummary["status"]) => void;
  setTags: (conversationId: string, tags: string[]) => Promise<void>;
  /**
   * Reflect a changed assignee in the loaded list, so the "Mine" folder and the
   * folder counts move the instant someone is assigned — the details panel owns
   * the API call and calls this to keep the list in step.
   */
  applyAssignment: (conversationId: string, employeeId: string | null) => void;
  /** The assignee's name for the row label — kept in step alongside applyAssignment. */
  applyAssigneeName: (conversationId: string, name: string | null) => void;
  /** Reload just the open thread's timeline (after a call is logged, say). */
  refreshTimeline: (conversationId: string) => Promise<void>;
}

export const useInboxStore = create<InboxState>((set, get) => ({
  selectedOrg: "zipicka",
  selectedConversationId: null,
  conversations: [],
  messagesByConversation: {},
  timelineByConversation: {},
  inboxSettings: DEFAULT_INBOX_SETTINGS,
  isLoadingConversations: false,
  isLoadingMessages: false,
  loadError: "",
  sendError: "",
  socketStatus: "connecting",

  setSocketStatus: (status) => set({ socketStatus: status }),

  setSelectedOrg: (org) => {
    set({
      selectedOrg: org,
      selectedConversationId: null,
      conversations: [],
      loadError: "",
      sendError: "",
      inboxSettings: DEFAULT_INBOX_SETTINGS,
    });
    get().loadConversations();
    get().loadInboxSettings();
  },

  selectConversation: (conversationId) => {
    set((state) => ({
      selectedConversationId: conversationId,
      sendError: "",
      // Opening a thread IS reading it — clear the badge at once, then tell the
      // server (best-effort: a failed mark only means the badge returns on reload).
      conversations: state.conversations.map((c) => (c.id === conversationId ? { ...c, unreadCount: 0 } : c)),
    }));
    get().loadMessages(conversationId);
    void api.markConversationRead(conversationId).catch(() => {});
  },

  closeConversation: () => set({ selectedConversationId: null, sendError: "" }),

  loadConversations: async () => {
    set({ isLoadingConversations: true, loadError: "" });
    try {
      const { conversations } = await api.getConversations(get().selectedOrg);
      set({ conversations });
    } catch (err) {
      // Recorded rather than thrown into an effect nobody listens to. The list
      // is left as it is and the page refuses to draw it — emptying it here
      // would produce "No conversations yet", which is the answer this failure
      // must not be mistaken for.
      set({ loadError: readableError(err) });
    } finally {
      set({ isLoadingConversations: false });
    }
  },

  loadInboxSettings: async () => {
    const org = get().selectedOrg;
    try {
      const { settings } = await api.getInboxSettings(org);
      // Only adopt it if the person has not moved to another business meanwhile.
      if (get().selectedOrg === org) set({ inboxSettings: settings });
    } catch {
      // The defaults stand; a settings read failing must not break the inbox.
    }
  },

  setInboxSettings: (settings) => set({ inboxSettings: settings }),

  loadMessages: async (conversationId) => {
    set({ isLoadingMessages: true, loadError: "" });
    try {
      const { messages, timeline } = await api.getMessages(conversationId);
      set((state) => ({
        messagesByConversation: { ...state.messagesByConversation, [conversationId]: messages },
        timelineByConversation: { ...state.timelineByConversation, [conversationId]: timeline ?? [] },
      }));
    } catch (err) {
      // A thread that fails to load shows nothing rather than the previous
      // conversation's messages — somebody else's customer under this
      // customer's name, one click away from a reply.
      set({ loadError: readableError(err) });
    } finally {
      set({ isLoadingMessages: false });
    }
  },

  refreshTimeline: async (conversationId) => {
    try {
      const { timeline } = await api.getMessages(conversationId);
      set((state) => ({
        timelineByConversation: { ...state.timelineByConversation, [conversationId]: timeline ?? [] },
      }));
    } catch {
      // Stale timeline for a moment is fine; the next open reloads it.
    }
  },

  appendMessage: (conversationId, message) => {
    const state0 = get();
    const isNewConversation = !state0.conversations.some((c) => c.id === conversationId);
    const isOpen = state0.selectedConversationId === conversationId;

    set((state) => {
      const existing = state.messagesByConversation[conversationId] ?? [];
      if (existing.some((m) => m.id === message.id)) return state; // dedupe optimistic + WS echo
      return {
        messagesByConversation: {
          ...state.messagesByConversation,
          [conversationId]: [...existing, message],
        },
        conversations: state.conversations
          .map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  lastMessagePreview: message.body,
                  lastMessageAt: message.createdAt,
                  // Keep the "awaiting reply" dot honest as messages stream in.
                  lastMessageDirection: message.direction,
                  // A customer writing again reopens a resolved thread (server
                  // trigger, migration 090) — mirror it so it leaves "Closed".
                  status:
                    message.direction === "inbound" && (c.status === "resolved" || c.status === "closed")
                      ? "open"
                      : c.status,
                  unreadCount:
                    message.direction === "inbound" && !isOpen ? (c.unreadCount ?? 0) + 1 : isOpen ? 0 : c.unreadCount,
                }
              : c
          )
          // RE-SORTED: a thread that just got a message moves to the top, as
          // the server orders it — it used to stay put until the next reload.
          .sort(byActivity),
      };
    });

    // Reading it as it arrives counts as reading it.
    if (isOpen && message.direction === "inbound") {
      void api.markConversationRead(conversationId).catch(() => {});
    }

    // A message for a conversation we don't have yet (new contact, or a
    // conversation started while this client was disconnected) — refresh the
    // list rather than trying to reconstruct a summary row by hand.
    if (isNewConversation) void get().loadConversations();
  },

  sendMessage: async (conversationId, text) => {
    set({ sendError: "" });
    let message;
    try {
      ({ message } = await api.sendMessage(conversationId, text));
    } catch (err) {
      // THE PERSON MUST BE TOLD. A rejected send — Meta refusing a message
      // outside the 24-hour window is the common one — must never look like a
      // send that worked while the customer waits on a reply that does not exist.
      set({ sendError: readableError(err, "The message was not sent.") });
      throw err;
    }
    get().appendMessage(conversationId, message);
    get().applyHandoffChange(conversationId, true);
    void get().refreshTimeline(conversationId);
  },

  setHumanHandoff: async (conversationId, isHumanHandoff) => {
    // Optimistic — and now reverted on failure. It used to flip the box, fire
    // the request and never look back, so a refused toggle left the wrong state
    // on screen (and an unhandled rejection in the console).
    get().applyHandoffChange(conversationId, isHumanHandoff);
    try {
      await api.setHandoff(conversationId, isHumanHandoff);
      void get().refreshTimeline(conversationId);
    } catch (err) {
      get().applyHandoffChange(conversationId, !isHumanHandoff);
      set({ sendError: readableError(err, "The handoff did not change.") });
    }
  },

  applyHandoffChange: (conversationId, isHumanHandoff) =>
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === conversationId ? { ...c, isHumanHandoff } : c
      ),
    })),

  setStatus: async (conversationId, status) => {
    const previous = get().conversations.find((c) => c.id === conversationId)?.status ?? "open";
    get().applyStatusChange(conversationId, status);
    try {
      await api.setConversationStatus(conversationId, status);
      void get().refreshTimeline(conversationId);
    } catch (err) {
      get().applyStatusChange(conversationId, previous);
      set({ sendError: readableError(err, status === "resolved" ? "Could not resolve this." : "Could not reopen this.") });
    }
  },

  applyStatusChange: (conversationId, status) =>
    set((state) => ({
      conversations: state.conversations.map((c) => (c.id === conversationId ? { ...c, status } : c)),
    })),

  applyAssignment: (conversationId, employeeId) =>
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === conversationId ? { ...c, assignedEmployeeId: employeeId } : c
      ),
    })),

  applyAssigneeName: (conversationId, name) =>
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === conversationId ? { ...c, assignedEmployeeName: name } : c
      ),
    })),

  setTags: async (conversationId, tags) => {
    // Optimistic: the chip appears the moment it is typed. The server normalises
    // (trim, de-dupe, cap) and we adopt whatever it kept; on failure we put the
    // previous set back rather than leaving a label that was never saved.
    const previous = get().conversations.find((c) => c.id === conversationId)?.tags ?? [];
    const apply = (next: string[]) =>
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === conversationId ? { ...c, tags: next } : c
        ),
      }));
    apply(tags);
    try {
      const res = await api.setConversationTags(conversationId, tags);
      apply(res.tags);
    } catch (err) {
      apply(previous);
      set({ sendError: readableError(err, "Could not update the labels.") });
    }
  },
}));

// Re-exported so existing imports keep working; the list itself lives in
// lib/tenants.ts, which is the only place the five businesses are described.
export { BUSINESS_OPTIONS } from "./tenants";
