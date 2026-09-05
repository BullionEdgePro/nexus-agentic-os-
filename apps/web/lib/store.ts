import { readableError } from "./api";
import { create } from "zustand";
import type { BusinessSlug, ConversationSummary, MessageDto } from "@nexus/shared";
import * as api from "./api";

interface InboxState {
  selectedOrg: BusinessSlug;
  selectedConversationId: string | null;
  conversations: ConversationSummary[];
  messagesByConversation: Record<string, MessageDto[]>;
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
   *
   * That is the same failure as the operator sweep going silent, in the surface
   * a human actually uses.
   */
  loadError: string;
  /**
   * A SEND that failed. Kept separate because the consequence is different: the
   * thread on screen is still correct, and what needs saying is that the words
   * in the box did not reach anybody.
   */
  sendError: string;

  setSelectedOrg: (org: BusinessSlug) => void;
  selectConversation: (conversationId: string) => void;
  loadConversations: () => Promise<void>;
  loadMessages: (conversationId: string) => Promise<void>;
  appendMessage: (conversationId: string, message: MessageDto) => void;
  sendMessage: (conversationId: string, text: string) => Promise<void>;
  setHumanHandoff: (conversationId: string, isHumanHandoff: boolean) => Promise<void>;
  applyHandoffChange: (conversationId: string, isHumanHandoff: boolean) => void;
}

export const useInboxStore = create<InboxState>((set, get) => ({
  selectedOrg: "zipicka",
  selectedConversationId: null,
  conversations: [],
  messagesByConversation: {},
  isLoadingConversations: false,
  isLoadingMessages: false,
  loadError: "",
  sendError: "",

  setSelectedOrg: (org) => {
    set({ selectedOrg: org, selectedConversationId: null, conversations: [], loadError: "", sendError: "" });
    get().loadConversations();
  },

  selectConversation: (conversationId) => {
    set({ selectedConversationId: conversationId });
    get().loadMessages(conversationId);
  },

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

  loadMessages: async (conversationId) => {
    set({ isLoadingMessages: true, loadError: "" });
    try {
      const { messages } = await api.getMessages(conversationId);
      set((state) => ({
        messagesByConversation: { ...state.messagesByConversation, [conversationId]: messages },
      }));
    } catch (err) {
      // A thread that fails to load shows nothing rather than the previous
      // conversation's messages, which is what an unhandled rejection left on
      // screen: somebody else's customer under this customer's name, one click
      // away from a reply.
      set({ loadError: readableError(err) });
    } finally {
      set({ isLoadingMessages: false });
    }
  },

  appendMessage: (conversationId, message) => {
    const isNewConversation = !get().conversations.some((c) => c.id === conversationId);

    set((state) => {
      const existing = state.messagesByConversation[conversationId] ?? [];
      if (existing.some((m) => m.id === message.id)) return state; // dedupe optimistic + WS echo
      return {
        messagesByConversation: {
          ...state.messagesByConversation,
          [conversationId]: [...existing, message],
        },
        conversations: state.conversations.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                lastMessagePreview: message.body,
                lastMessageAt: message.createdAt,
                // Keep the "awaiting reply" dot honest as messages stream in.
                lastMessageDirection: message.direction,
              }
            : c
        ),
      };
    });

    // A message for a conversation we don't have yet (new contact, or a
    // conversation started while this client was disconnected) — refresh
    // the list rather than trying to reconstruct a summary row by hand.
    if (isNewConversation) void get().loadConversations();
  },

  sendMessage: async (conversationId, text) => {
    set({ sendError: "" });
    let message;
    try {
      ({ message } = await api.sendMessage(conversationId, text));
    } catch (err) {
      // THE PERSON MUST BE TOLD. Before this, a rejected send — Meta refusing a
      // message outside the 24-hour window is the common one — stopped the
      // spinner, left the draft in the box and said nothing. Whoever typed it
      // has no way to tell that from a send that worked, and the customer is
      // waiting on a reply that does not exist.
      set({ sendError: readableError(err, "The message was not sent.") });
      throw err;
    }
    get().appendMessage(conversationId, message);
    get().applyHandoffChange(conversationId, true);
  },

  setHumanHandoff: async (conversationId, isHumanHandoff) => {
    get().applyHandoffChange(conversationId, isHumanHandoff);
    await api.setHandoff(conversationId, isHumanHandoff);
  },

  applyHandoffChange: (conversationId, isHumanHandoff) =>
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === conversationId ? { ...c, isHumanHandoff } : c
      ),
    })),
}));

// Re-exported so existing imports keep working; the list itself lives in
// lib/tenants.ts, which is the only place the five businesses are described.
export { BUSINESS_OPTIONS } from "./tenants";
