import "server-only";
import type { Conversation, Message } from "../../lib/api-types";
import type { Page } from "../../lib/types";
import { all, one, run, summary, placeholders, type UserRow } from "./core";
import { transaction } from "../db";
import { newId } from "../security";
import { AppError } from "../errors";
import { assertCanInteract } from "./safety";
import { decodeCursor, encodeCursor, type PageOptions } from "./pagination";
import type { EncryptedEnvelope } from "../../lib/e2ee-contract";
import { validateEncryptedEnvelope } from "./encryption";

type ConversationRow = { id: string; user_a: string; user_b: string; created_at: number; updated_at: number };
type MessageRow = { seq: number; id: string; conversation_id: string; sender_id: string; envelope: string | null; legacy_removed: number; created_at: number };
function member(viewerId: string, id: string): ConversationRow {
  const row = one<ConversationRow>("SELECT * FROM conversations WHERE id=? AND (user_a=? OR user_b=?)", id, viewerId, viewerId);
  // Hide whether conversations belonging to other people exist.
  if (!row) throw new AppError(404, "not_found", "Conversation not found");
  return row;
}
function hydrateMessages(rows: MessageRow[], knownChats?: ConversationRow[]): Message[] {
  if (!rows.length) return [];
  const chatIds = [...new Set(rows.map(r => r.conversation_id))];
  const chats = new Map((knownChats ?? all<ConversationRow>(`SELECT * FROM conversations WHERE id IN (${placeholders(chatIds)})`, ...chatIds)).map(r => [r.id, r]));
  const senderIds = [...new Set(rows.map(r => r.sender_id))];
  const senders = new Map(all<UserRow>(`SELECT * FROM users WHERE id IN (${placeholders(senderIds)})`, ...senderIds).map(r => [r.id, summary(r)]));
  return rows.map(row => {
    const chat = chats.get(row.conversation_id)!;
    return { id: row.id, conversationId: row.conversation_id, sender: senders.get(row.sender_id)!, recipientId: chat.user_a === row.sender_id ? chat.user_b : chat.user_a, encryption: row.envelope ? JSON.parse(row.envelope) as EncryptedEnvelope : null, legacyRemoved: !!row.legacy_removed, createdAt: new Date(row.created_at).toISOString() };
  });
}
function message(row: MessageRow): Message { return hydrateMessages([row])[0]; }
function hydrateConversations(rows: ConversationRow[], viewerId: string): Conversation[] {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id), targets = rows.map(r => r.user_a === viewerId ? r.user_b : r.user_a);
  const people = new Map(all<UserRow & { blocked: number; blocked_by: number; muted: number }>(`SELECT u.*,
    EXISTS(SELECT 1 FROM blocks b WHERE b.user_id=? AND b.target_id=u.id) blocked,
    EXISTS(SELECT 1 FROM blocks b WHERE b.user_id=u.id AND b.target_id=?) blocked_by,
    EXISTS(SELECT 1 FROM mutes m WHERE m.user_id=? AND m.target_id=u.id) muted
    FROM users u WHERE u.id IN (${placeholders(targets)})`, viewerId, viewerId, viewerId, ...targets).map(r => [r.id, r]));
  const lastRows = all<MessageRow>(`SELECT m.* FROM messages m WHERE m.seq IN (
    SELECT (SELECT seq FROM messages WHERE conversation_id=c.id ORDER BY seq DESC LIMIT 1)
    FROM conversations c WHERE c.id IN (${placeholders(ids)}))`, ...ids);
  const last = new Map(hydrateMessages(lastRows, rows).map(m => [m.conversationId, m]));
  const unread = new Map(all<{ conversation_id: string; n: number }>(`SELECT m.conversation_id,COUNT(*) n FROM messages m
    LEFT JOIN conversation_reads r ON r.conversation_id=m.conversation_id AND r.user_id=?
    WHERE m.conversation_id IN (${placeholders(ids)}) AND m.sender_id<>? AND m.seq>COALESCE(r.last_read_seq,0)
    GROUP BY m.conversation_id`, viewerId, ...ids, viewerId).map(r => [r.conversation_id, r.n]));
  return rows.map(row => {
    const person = people.get(row.user_a === viewerId ? row.user_b : row.user_a)!;
    return { id: row.id, participant: summary(person), lastMessage: last.get(row.id) ?? null, unreadCount: unread.get(row.id) ?? 0, blocked: !!(person.blocked || person.blocked_by), muted: !!person.muted, updatedAt: new Date(row.updated_at).toISOString() };
  });
}
function conversation(row: ConversationRow, viewerId: string): Conversation { return hydrateConversations([row], viewerId)[0]; }
export function conversationById(viewerId: string, id: string): Conversation { return conversation(member(viewerId, id), viewerId); }
export function createConversation(viewerId: string, recipientId: string): { conversation: Conversation; created: boolean } {
  if (viewerId === recipientId) throw new AppError(400, "invalid_target", "Choose another person to message");
  return transaction(() => {
    if (!one("SELECT 1 FROM users WHERE id=?", recipientId)) throw new AppError(404, "not_found", "User not found");
    assertCanInteract(viewerId, recipientId);
    const [a, b] = [viewerId, recipientId].sort();
    const existing = one<ConversationRow>("SELECT * FROM conversations WHERE user_a=? AND user_b=?", a, b);
    if (existing) return { conversation: conversation(existing, viewerId), created: false };
    const now = Date.now(), id = newId();
    run("INSERT INTO conversations VALUES(?,?,?,?,?)", id, a, b, now, now);
    return { conversation: conversationById(viewerId, id), created: true };
  });
}
export function conversationsFor(viewerId: string, options: PageOptions): Page<Conversation> {
  const scope = `conversations:${viewerId}`;
  const key = decodeCursor(options.cursor, scope, ["number", "string"]);
  const rows = all<ConversationRow>(`SELECT * FROM conversations WHERE (user_a=? OR user_b=?)
    ${key ? "AND (updated_at<? OR (updated_at=? AND id<?))" : ""} ORDER BY updated_at DESC,id DESC LIMIT ?`, viewerId, viewerId, ...(key ? [key[0], key[0], key[1]] : []), options.limit + 1);
  const selected = rows.slice(0, options.limit), last = selected.at(-1);
  return { items: hydrateConversations(selected, viewerId), nextCursor: rows.length > options.limit && last ? encodeCursor(scope, [last.updated_at, last.id]) : null };
}
export function messagesFor(viewerId: string, id: string, options: PageOptions): Page<Message> {
  const chat = member(viewerId, id);
  const scope = `messages:${viewerId}:${id}`, key = decodeCursor(options.cursor, scope, ["number"]);
  const rows = all<MessageRow>(`SELECT * FROM messages WHERE conversation_id=? ${key ? "AND seq<?" : ""} ORDER BY seq DESC LIMIT ?`, id, ...(key ? [key[0]] : []), options.limit + 1);
  const selected = rows.slice(0, options.limit), last = selected.at(-1);
  return { items: hydrateMessages(selected, [chat]), nextCursor: rows.length > options.limit && last ? encodeCursor(scope, [last.seq]) : null };
}
export function sendMessage(viewerId: string, id: string, encryption: EncryptedEnvelope): Message {
  return transaction(() => {
    const row = member(viewerId, id);
    assertCanInteract(viewerId, row.user_a === viewerId ? row.user_b : row.user_a);
    validateEncryptedEnvelope({ conversationId: id, senderId: viewerId, recipientId: row.user_a === viewerId ? row.user_b : row.user_a }, encryption);
    const encoded = JSON.stringify(Object.fromEntries(["version", "clientId", "senderKeyId", "recipientKeyId", "ephemeralPublicKey", "salt", "recipientIv", "recipientCiphertext", "senderIv", "senderCiphertext", "signature"].map(k => [k, encryption[k as keyof EncryptedEnvelope]])));
    const existing = one<MessageRow>("SELECT * FROM messages WHERE conversation_id=? AND sender_id=? AND client_id=?", id, viewerId, encryption.clientId);
    if (existing) {
      if (existing.envelope !== encoded) throw new AppError(409, "message_conflict", "This client ID already belongs to another encrypted message");
      return message(existing);
    }
    const latest = one<{ created_at: number }>("SELECT created_at FROM messages WHERE conversation_id=? ORDER BY seq DESC LIMIT 1", id);
    // Stable chronological ordering even when several sends arrive in one millisecond.
    const messageId = newId(), now = Math.max(Date.now(), (latest?.created_at ?? 0) + 1);
    run("INSERT INTO messages(id,conversation_id,sender_id,client_id,envelope,created_at) VALUES(?,?,?,?,?,?)", messageId, id, viewerId, encryption.clientId, encoded, now);
    run("UPDATE conversations SET updated_at=? WHERE id=?", now, id);
    return message(one<MessageRow>("SELECT * FROM messages WHERE id=?", messageId)!);
  });
}
export function unreadMessageCount(viewerId: string): number {
  return one<{ n: number }>(`SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id=m.conversation_id
    WHERE (c.user_a=? OR c.user_b=?) AND m.sender_id<>?
    AND m.seq>COALESCE((SELECT r.last_read_seq FROM conversation_reads r WHERE r.conversation_id=c.id AND r.user_id=?),0)
    AND NOT EXISTS(SELECT 1 FROM mutes WHERE user_id=? AND target_id=m.sender_id)
    AND NOT EXISTS(SELECT 1 FROM blocks WHERE (user_id=? AND target_id=m.sender_id) OR (user_id=m.sender_id AND target_id=?))`, viewerId, viewerId, viewerId, viewerId, viewerId, viewerId, viewerId)!.n;
}
export function markConversationRead(viewerId: string, id: string, upToMessageId?: string): number {
  return transaction(() => {
    member(viewerId, id);
    const end = upToMessageId ? one<{ seq: number }>("SELECT seq FROM messages WHERE id=? AND conversation_id=?", upToMessageId, id)
      : one<{ seq: number }>("SELECT COALESCE(MAX(seq),0) AS seq FROM messages WHERE conversation_id=?", id);
    if (!end) throw new AppError(404, "not_found", "Message not found in this conversation");
    run(`INSERT INTO conversation_reads VALUES(?,?,?) ON CONFLICT(conversation_id,user_id)
      DO UPDATE SET last_read_seq=MAX(conversation_reads.last_read_seq,excluded.last_read_seq)`, id, viewerId, end.seq);
    return conversationById(viewerId, id).unreadCount;
  });
}
export function deleteMessage(viewerId: string, id: string): void {
  transaction(() => {
    const row = one<MessageRow>(`SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE m.id=? AND (c.user_a=? OR c.user_b=?)`, id, viewerId, viewerId);
    if (!row) throw new AppError(404, "not_found", "Message not found");
    if (row.sender_id !== viewerId) throw new AppError(403, "forbidden", "You can only delete your own messages");
    run("DELETE FROM messages WHERE id=?", id);
  });
}
