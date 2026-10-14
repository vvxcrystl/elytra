import { BACKUP_PROTOCOL, DM_PROTOCOL, envelopeBytes, identityBytes, payloadContext, registrationBytes, type PublicIdentity, type IdentityRegistration, type IdentityBackup, type EncryptedEnvelope, type MessageContext } from "./e2ee-contract";

/** Runs on the endpoints' devices. The server imports only e2ee-contract.ts. */
export type ClientIdentity = PublicIdentity & { encryptionPrivateKey: CryptoKey; signingPrivateKey: CryptoKey };
const curve = { name: "ECDH", namedCurve: "P-256" };
const signing = { name: "ECDSA", namedCurve: "P-256" };
const signatureAlgorithm = { name: "ECDSA", hash: "SHA-256" };
export function toBase64(bytes: Uint8Array): string {
  let binary = ""; for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encrypted data encoding");
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const result = Uint8Array.from(binary, c => c.charCodeAt(0));
  if (toBase64(result) !== value) throw new Error("Noncanonical encrypted data encoding");
  return result;
}
const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));
export async function identityId(identity: PublicIdentity): Promise<string> { return toBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", identityBytes(identity)))); }
export async function checkPublicIdentity(identity: PublicIdentity): Promise<void> {
  if (await identityId(identity) !== identity.keyId) throw new Error("Encryption identity fingerprint does not match its keys");
  await crypto.subtle.importKey("spki", fromBase64(identity.encryptionPublicKey), curve, false, []);
  await crypto.subtle.importKey("spki", fromBase64(identity.signingPublicKey), signing, false, ["verify"]);
}
function backupContext(identity: PublicIdentity): Uint8Array<ArrayBuffer> { return new TextEncoder().encode(JSON.stringify([BACKUP_PROTOCOL, identity.userId, identity.keyId, identity.encryptionPublicKey, identity.signingPublicKey])); }
async function restorePrivateKeys(identity: PublicIdentity, encryptionPrivate: Uint8Array<ArrayBuffer>, signingPrivate: Uint8Array<ArrayBuffer>): Promise<ClientIdentity> {
  const encryptionPrivateKey = await crypto.subtle.importKey("pkcs8", encryptionPrivate, curve, false, ["deriveBits"]);
  const signingPrivateKey = await crypto.subtle.importKey("pkcs8", signingPrivate, signing, false, ["sign"]);
  // Reject a backup whose private keys do not match the published public identity.
  const signature = await crypto.subtle.sign(signatureAlgorithm, signingPrivateKey, identityBytes(identity));
  const signingPublic = await crypto.subtle.importKey("spki", fromBase64(identity.signingPublicKey), signing, false, ["verify"]);
  if (!await crypto.subtle.verify(signatureAlgorithm, signingPublic, signature, identityBytes(identity))) throw new Error("Recovery keys do not match this account");
  const ephemeral = await crypto.subtle.generateKey(curve, false, ["deriveBits"]);
  const encryptionPublic = await crypto.subtle.importKey("spki", fromBase64(identity.encryptionPublicKey), curve, false, []);
  const a = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: ephemeral.publicKey }, encryptionPrivateKey, 256));
  const b = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: encryptionPublic }, ephemeral.privateKey, 256));
  let different = 0; for (let i = 0; i < a.length; i++) different |= a[i] ^ b[i]; a.fill(0); b.fill(0);
  if (different) throw new Error("Recovery keys do not match this account");
  return { ...identity, encryptionPrivateKey, signingPrivateKey };
}
export async function generateIdentity(userId: string): Promise<{ identity: ClientIdentity; registration: IdentityRegistration; recoveryCode: string }> {
  const enc = await crypto.subtle.generateKey(curve, true, ["deriveBits"]);
  const sign = await crypto.subtle.generateKey(signing, true, ["sign", "verify"]);
  const publicIdentity: PublicIdentity = { userId, keyId: "", encryptionPublicKey: toBase64(new Uint8Array(await crypto.subtle.exportKey("spki", enc.publicKey))), signingPublicKey: toBase64(new Uint8Array(await crypto.subtle.exportKey("spki", sign.publicKey))) };
  publicIdentity.keyId = await identityId(publicIdentity);
  const encPrivate = new Uint8Array(await crypto.subtle.exportKey("pkcs8", enc.privateKey)), signPrivate = new Uint8Array(await crypto.subtle.exportKey("pkcs8", sign.privateKey));
  const secret = random(32), iv = random(12);
  const recoveryCode = toBase64(secret);
  const key = await crypto.subtle.importKey("raw", secret, "AES-GCM", false, ["encrypt"]); secret.fill(0);
  const clear = new TextEncoder().encode(JSON.stringify([BACKUP_PROTOCOL, userId, toBase64(encPrivate), toBase64(signPrivate)]));
  try {
    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: backupContext(publicIdentity), tagLength: 128 }, key, clear);
    const registration = { keyId: publicIdentity.keyId, encryptionPublicKey: publicIdentity.encryptionPublicKey, signingPublicKey: publicIdentity.signingPublicKey, backupIv: toBase64(iv), backupCiphertext: toBase64(new Uint8Array(cipher)), proof: "" };
    const identity = await restorePrivateKeys(publicIdentity, encPrivate, signPrivate);
    registration.proof = toBase64(new Uint8Array(await crypto.subtle.sign(signatureAlgorithm, identity.signingPrivateKey, registrationBytes(userId, registration))));
    return { identity, registration, recoveryCode };
  } finally { clear.fill(0); encPrivate.fill(0); signPrivate.fill(0); }
}
export async function recoverIdentity(backup: IdentityBackup, recoveryCode: string): Promise<ClientIdentity> {
  await checkPublicIdentity(backup);
  const secret = fromBase64(recoveryCode.trim());
  if (secret.length !== 32) throw new Error("Enter the 43-character recovery code you saved");
  let clear: Uint8Array<ArrayBuffer> | undefined;
  try {
    const key = await crypto.subtle.importKey("raw", secret, "AES-GCM", false, ["decrypt"]);
    clear = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(backup.backupIv), additionalData: backupContext(backup), tagLength: 128 }, key, fromBase64(backup.backupCiphertext)));
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(clear));
    if (!Array.isArray(data) || data.length !== 4 || data[0] !== BACKUP_PROTOCOL || data[1] !== backup.userId || typeof data[2] !== "string" || typeof data[3] !== "string") throw new Error();
    const enc = fromBase64(data[2]), sign = fromBase64(data[3]);
    try { return await restorePrivateKeys({ userId: backup.userId, keyId: backup.keyId, encryptionPublicKey: backup.encryptionPublicKey, signingPublicKey: backup.signingPublicKey }, enc, sign); }
    finally { enc.fill(0); sign.fill(0); }
  } catch { throw new Error("Recovery code is incorrect or the encrypted backup was altered"); }
  finally { secret.fill(0); clear?.fill(0); }
}
async function payloadKey(privateKey: CryptoKey, publicKey: CryptoKey, salt: Uint8Array<ArrayBuffer>, context: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256));
  try {
    const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: context }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  } finally { secret.fill(0); }
}
export async function encryptText(sender: ClientIdentity, recipient: PublicIdentity, context: MessageContext, content: string): Promise<EncryptedEnvelope> {
  if (context.senderId !== sender.userId || context.recipientId !== recipient.userId || sender.userId === recipient.userId) throw new Error("Invalid message participants");
  const text = content.trim(); if (!text || [...text].length > 10000) throw new Error("Messages must be 1–10,000 characters");
  await checkPublicIdentity(recipient);
  const ephemeral = await crypto.subtle.generateKey(curve, false, ["deriveBits"]), salt = random(32);
  const envelope: EncryptedEnvelope = { version: DM_PROTOCOL, clientId: crypto.randomUUID(), senderKeyId: sender.keyId, recipientKeyId: recipient.keyId, ephemeralPublicKey: toBase64(new Uint8Array(await crypto.subtle.exportKey("spki", ephemeral.publicKey))), salt: toBase64(salt), recipientIv: toBase64(random(12)), recipientCiphertext: "", senderIv: toBase64(random(12)), senderCiphertext: "", signature: "" };
  const clear = new TextEncoder().encode(text);
  try {
    for (const identity of [sender, recipient]) {
      const copy = identity.userId === sender.userId ? "sender" : "recipient";
      const aad = payloadContext(context, envelope, identity.userId);
      const publicKey = await crypto.subtle.importKey("spki", fromBase64(identity.encryptionPublicKey), curve, false, []);
      const key = await payloadKey(ephemeral.privateKey, publicKey, salt, aad);
      envelope[`${copy}Ciphertext`] = toBase64(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: fromBase64(envelope[`${copy}Iv`]), additionalData: aad, tagLength: 128 }, key, clear)));
    }
    envelope.signature = toBase64(new Uint8Array(await crypto.subtle.sign(signatureAlgorithm, sender.signingPrivateKey, envelopeBytes(context, envelope))));
    return envelope;
  } finally { clear.fill(0); }
}
export async function decryptText(viewer: ClientIdentity, sender: PublicIdentity, context: MessageContext, envelope: EncryptedEnvelope): Promise<string> {
  if (envelope.version !== DM_PROTOCOL || context.senderId !== sender.userId || sender.keyId !== envelope.senderKeyId) throw new Error("Message encryption identity mismatch");
  const mine = viewer.userId === context.senderId;
  if ((!mine && viewer.userId !== context.recipientId) || viewer.keyId !== (mine ? envelope.senderKeyId : envelope.recipientKeyId)) throw new Error("This device does not have the message's decryption key");
  await checkPublicIdentity(sender);
  const signingPublic = await crypto.subtle.importKey("spki", fromBase64(sender.signingPublicKey), signing, false, ["verify"]);
  if (!await crypto.subtle.verify(signatureAlgorithm, signingPublic, fromBase64(envelope.signature), envelopeBytes(context, envelope))) throw new Error("Message signature is invalid");
  const publicKey = await crypto.subtle.importKey("spki", fromBase64(envelope.ephemeralPublicKey), curve, false, []);
  const aad = payloadContext(context, envelope, viewer.userId), key = await payloadKey(viewer.encryptionPrivateKey, publicKey, fromBase64(envelope.salt), aad);
  const clear = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(mine ? envelope.senderIv : envelope.recipientIv), additionalData: aad, tagLength: 128 }, key, fromBase64(mine ? envelope.senderCiphertext : envelope.recipientCiphertext)));
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(clear);
    if (!text.trim() || [...text].length > 10000) throw new Error("Invalid decrypted message length");
    return text;
  } finally { clear.fill(0); }
}
export async function safetyNumber(a: PublicIdentity, b: PublicIdentity): Promise<string> {
  const participants = [a, b].sort((x, y) => x.userId < y.userId ? -1 : x.userId > y.userId ? 1 : 0).map(i => [i.userId, i.keyId]);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([DM_PROTOCOL, "verify", participants]))));
  return Array.from(hash, b => b.toString(16).padStart(2, "0")).join("").match(/.{4}/g)!.join(" ");
}
