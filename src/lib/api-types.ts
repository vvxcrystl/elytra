import type { UserSummary } from "./types";
import type { EncryptedEnvelope } from "./e2ee-contract";

export type Message = {
  id: string;
  conversationId: string;
  sender: UserSummary;
  recipientId: string;
  encryption: EncryptedEnvelope | null;
  legacyRemoved: boolean;
  createdAt: string;
};
/** Decrypted UI state exists in memory only, never in API requests or browser storage. */
export type DisplayMessage = Message & { content: string; decryptionError?: boolean };
export type DisplayConversation = Omit<Conversation, "lastMessage"> & { lastMessage: DisplayMessage | null };

export type Conversation = {
  id: string;
  participant: UserSummary;
  lastMessage: Message | null;
  unreadCount: number;
  blocked: boolean;
  muted: boolean;
  updatedAt: string;
};
