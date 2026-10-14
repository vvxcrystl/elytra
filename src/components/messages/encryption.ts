"use client";

import type { Conversation, Message, DisplayMessage } from "@/lib/api-types";
import type { PublicIdentity, IdentityBackup, IdentityRegistration, EncryptedEnvelope } from "@/lib/e2ee-contract";
import { checkPublicIdentity, generateIdentity, recoverIdentity, encryptText, decryptText, safetyNumber, type ClientIdentity } from "@/lib/e2ee";
import { loadIdentity, saveIdentity, checkPin } from "@/lib/e2ee-store";

let active: ClientIdentity | null = null;
let pending: { identity: ClientIdentity; registration: IdentityRegistration } | null = null;
let generation = 0;
const peerCache = new Map<string, { expires: number; promise: Promise<PublicIdentity | null> }>();
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { method: body === undefined ? "GET" : "PUT", credentials: "same-origin", cache: "no-store", ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok || !Object.hasOwn(result, "data")) throw new Error(result.error?.message || "Unable to load encryption keys");
  return result.data as T;
}
function available() {
  if (!globalThis.crypto?.subtle || typeof indexedDB === "undefined") throw new Error("Encrypted messages require HTTPS and a browser with secure key storage");
}
function current(): ClientIdentity {
  if (!active) throw new Error("Unlock encrypted messages on this device first");
  return active;
}
function stillCurrent(value: number) { if (generation !== value) throw new Error("Encryption operation interrupted. Retry on this account."); }
export function forgetEncryption(): void { generation++; active = null; pending = null; peerCache.clear(); }
export async function initializeEncryption(userId: string): Promise<"ready" | "setup" | "recovery"> {
  available(); const turn = ++generation; active = null; pending = null; peerCache.clear();
  const [local, backup] = await Promise.all([loadIdentity(userId), api<IdentityBackup | null>("/users/me/encryption-backup")]);
  stillCurrent(turn);
  if (backup && backup.userId !== userId) throw new Error("Encryption account mismatch. Sign in again.");
  if (backup) await checkPublicIdentity(backup);
  if (!local) return backup ? "recovery" : "setup";
  await checkPublicIdentity(local); stillCurrent(turn);
  if (!backup || local.userId !== userId || local.keyId !== backup.keyId || local.encryptionPrivateKey.extractable || local.signingPrivateKey.extractable) throw new Error("Your published encryption identity does not match this device. Sending is stopped.");
  active = local; return "ready";
}
export async function prepareEncryption(userId: string): Promise<string> {
  available(); const turn = generation;
  const { identity, registration, recoveryCode } = await generateIdentity(userId); stillCurrent(turn);
  pending = { identity, registration }; return recoveryCode;
}
export async function activateEncryption(userId: string): Promise<void> {
  const turn = generation, prepared = pending;
  if (!prepared || prepared.identity.userId !== userId) throw new Error("Generate and save a recovery code first");
  const published = await api<PublicIdentity>("/users/me/encryption-keys", prepared.registration); stillCurrent(turn);
  if (published.userId !== userId || published.keyId !== prepared.identity.keyId) throw new Error("Published encryption keys do not match this device");
  await saveIdentity(prepared.identity); stillCurrent(turn);
  active = prepared.identity; pending = null;
}
export async function recoverEncryption(userId: string, recoveryCode: string): Promise<void> {
  available(); const turn = generation;
  const backup = await api<IdentityBackup | null>("/users/me/encryption-backup"); stillCurrent(turn);
  if (!backup || backup.userId !== userId) throw new Error("Encrypted key backup not found for this account");
  const identity = await recoverIdentity(backup, recoveryCode); stillCurrent(turn);
  await saveIdentity(identity); stillCurrent(turn); active = identity; pending = null;
}
async function peerIdentity(userId: string, force = false): Promise<PublicIdentity | null> {
  const own = current(), turn = generation;
  const cached = peerCache.get(userId);
  if (!force && cached && cached.expires > Date.now()) return cached.promise;
  const promise = (async () => {
    const identity = await api<PublicIdentity | null>(`/users/${encodeURIComponent(userId)}/encryption-keys`); stillCurrent(turn);
    if (identity) {
      if (identity.userId !== userId) throw new Error("Contact encryption identity mismatch");
      await checkPublicIdentity(identity); await checkPin(own.userId, identity); stillCurrent(turn);
    }
    return identity;
  })();
  peerCache.set(userId, { expires: Date.now() + 5000, promise });
  try { return await promise; } catch (error) { if (peerCache.get(userId)?.promise === promise) peerCache.delete(userId); throw error; }
}
async function chat(id: string): Promise<Conversation> { return api<Conversation>(`/conversations/${encodeURIComponent(id)}`); }
export async function encryptMessage(conversationId: string, content: string): Promise<EncryptedEnvelope> {
  const own = current(), turn = generation;
  const conversation = await chat(conversationId), peer = await peerIdentity(conversation.participant.id, true);
  if (!peer) throw new Error("This person must enable encrypted messages before you can send");
  const envelope = await encryptText(own, peer, { conversationId, senderId: own.userId, recipientId: peer.userId }, content); stillCurrent(turn);
  return envelope;
}
export async function decryptMessage(message: Message): Promise<DisplayMessage> {
  if (message.legacyRemoved) return { ...message, content: "Legacy message removed when encrypted messaging was enabled." };
  try {
    const own = current(), turn = generation;
    if (!message.encryption) throw new Error("Missing ciphertext");
    const sender = message.sender.id === own.userId ? own : await peerIdentity(message.sender.id);
    if (!sender) throw new Error("Sender's keys are unavailable");
    const content = await decryptText(own, sender, { conversationId: message.conversationId, senderId: message.sender.id, recipientId: message.recipientId }, message.encryption); stillCurrent(turn);
    return { ...message, content };
  } catch { return { ...message, content: "Unable to decrypt or verify this message.", decryptionError: true }; }
}
export async function conversationEncryptionInfo(id: string): Promise<{ safetyNumber: string | null; verified: boolean; recipientReady: boolean }> {
  const own = current(), turn = generation, conversation = await chat(id);
  const peer = await peerIdentity(conversation.participant.id, true); stillCurrent(turn);
  if (!peer) return { safetyNumber: null, verified: false, recipientReady: false };
  const pin = await checkPin(own.userId, peer), number = await safetyNumber(own, peer); stillCurrent(turn);
  return { safetyNumber: number, verified: pin.verified, recipientReady: true };
}
export async function verifyConversationKeys(id: string): Promise<void> {
  const own = current(), turn = generation, conversation = await chat(id);
  const peer = await peerIdentity(conversation.participant.id, true); stillCurrent(turn);
  if (!peer) throw new Error("This person has not enabled encrypted messages");
  await checkPin(own.userId, peer, true); stillCurrent(turn);
}
