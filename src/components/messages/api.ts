// Browser client for the /api/v1 messaging endpoints. Uses the session cookie.
// The server only ever sees encrypted envelopes. Decrypted text lives in the returned
// Display objects (React state) and is never written to storage or logs.

import type { Conversation, DisplayConversation, DisplayMessage, Message } from "@/lib/api-types";
import type { Profile, UserListItem } from "@/lib/types";
import { decryptMessage, encryptMessage } from "./encryption";

export const MESSAGE_MAX_LENGTH = 10_000;

export type UserRelationship = Profile & {
  isBlocked: boolean;
  isMuted: boolean;
  blockedBy: boolean;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

type Body<T> = {
  data?: T;
  meta?: { nextCursor: string | null };
  error?: { code: string; message: string };
};

async function request<T>(path: string, init?: RequestInit & { json?: unknown }) {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(init?.json !== undefined && { "Content-Type": "application/json" }),
        ...init?.headers,
      },
      body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    });
  } catch {
    throw new ApiError("Couldn't reach the server. Check your connection.", 0, "network_error");
  }

  const body = (await res.json().catch(() => ({}))) as Body<T>;
  if (!res.ok || body.data === undefined) {
    throw new ApiError(
      body.error?.message ?? "Something went wrong. Try again.",
      res.status,
      body.error?.code ?? "unknown",
    );
  }
  return { data: body.data, nextCursor: body.meta?.nextCursor ?? null };
}

function query(params: Record<string, string | number | null | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

async function decryptConversation(conversation: Conversation): Promise<DisplayConversation> {
  return {
    ...conversation,
    lastMessage: conversation.lastMessage ? await decryptMessage(conversation.lastMessage) : null,
  };
}

async function decryptPage<T, D>(page: { data: T[]; nextCursor: string | null }, fn: (item: T) => Promise<D>) {
  return { data: await Promise.all(page.data.map(fn)), nextCursor: page.nextCursor };
}

export async function listConversations(cursor?: string | null, limit = 20) {
  const page = await request<Conversation[]>(`/api/v1/conversations${query({ cursor, limit })}`);
  return decryptPage<Conversation, DisplayConversation>(page, decryptConversation);
}
export async function getUnreadMessageCount() {
  return (await request<{ unreadCount: number }>("/api/v1/conversations/unread-count")).data.unreadCount;
}

export async function getConversation(id: string) {
  return decryptConversation(
    (await request<Conversation>(`/api/v1/conversations/${encodeURIComponent(id)}`)).data,
  );
}

function postConversation(recipientId: string) {
  return request<Conversation>("/api/v1/conversations", { method: "POST", json: { recipientId } });
}

export async function startConversation(recipientId: string) {
  return decryptConversation((await postConversation(recipientId)).data);
}

/**
 * Opens (or creates) a conversation and returns only its id. Needs no encryption keys,
 * so it works outside the messages gate, e.g. from a profile page.
 */
export async function openConversationId(recipientId: string) {
  return (await postConversation(recipientId)).data.id;
}

/** Newest first. */
export async function listMessages(conversationId: string, cursor?: string | null, limit = 30) {
  const page = await request<Message[]>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages${query({ cursor, limit })}`,
  );
  return decryptPage<Message, DisplayMessage>(page, decryptMessage);
}

/** Encrypts locally, then posts only the envelope. Throws without sending if encryption fails. */
export async function sendMessage(conversationId: string, content: string): Promise<DisplayMessage> {
  const encryption = await encryptMessage(conversationId, content);
  const sent = await request<Message>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
    { method: "POST", json: { encryption } },
  );
  return decryptMessage(sent.data);
}

export async function markRead(conversationId: string, upToMessageId?: string) {
  return (
    await request<{ unreadCount: number }>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/read`,
      { method: "PUT", json: upToMessageId ? { upToMessageId } : {} },
    )
  ).data;
}

export async function deleteMessage(id: string) {
  return (await request<{ deleted: true }>(`/api/v1/messages/${encodeURIComponent(id)}`, { method: "DELETE" }))
    .data;
}

export async function searchUsers(q: string, signal?: AbortSignal) {
  return (await request<UserListItem[]>(`/api/v1/users${query({ q, limit: 20 })}`, { signal })).data;
}

export async function getUser(id: string) {
  return (await request<UserRelationship>(`/api/v1/users/${encodeURIComponent(id)}`)).data;
}

export async function setBlocked(userId: string, blocked: boolean) {
  return (
    await request<{ blocked: boolean }>(`/api/v1/users/${encodeURIComponent(userId)}/block`, {
      method: blocked ? "PUT" : "DELETE",
    })
  ).data;
}

export async function setMuted(userId: string, muted: boolean) {
  return (
    await request<{ muted: boolean }>(`/api/v1/users/${encodeURIComponent(userId)}/mute`, {
      method: muted ? "PUT" : "DELETE",
    })
  ).data;
}

export function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : "Something went wrong. Try again.";
}

/** Counts code points so emoji count as one character, matching the post composer. */
export function messageLength(text: string) {
  return [...text].length;
}
