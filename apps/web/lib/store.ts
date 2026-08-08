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

  setSelectedOrg: (org) => {
    set({ selectedOrg: org, selectedConversationId: null, conversations: [] });
    get().loadConversations();
  },

  selectConversation: (conversationId) => {
    set({ selectedConversationId: conversationId });
    get().loadMessages(conversationId);
  },

  loadConversations: async () => {
    set({ isLoadingConversations: true });
    try {
      const { conversations } = await api.getConversations(get().selectedOrg);
      set({ conversations });
    } finally {
      set({ isLoadingConversations: false });
    }
  },

  loadMessages: async (conversationId) => {
    set({ isLoadingMessages: true });
    try {
      const { messages } = await api.getMessages(conversationId);
      set((state) => ({
        messagesByConversation: { ...state.messagesByConversation, [conversationId]: messages },
      }));
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
            ? { ...c, lastMessagePreview: message.body, lastMessageAt: message.createdAt }
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
    const { message } = await api.sendMessage(conversationId, text);
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
