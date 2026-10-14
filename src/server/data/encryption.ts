import "server-only";
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { identityBytes, registrationBytes, envelopeBytes, DM_PROTOCOL, type PublicIdentity, type IdentityRegistration, type IdentityBackup, type EncryptedEnvelope, type MessageContext } from "../../lib/e2ee-contract";
import { one, run } from "./core";
import { transaction } from "../db";
import { AppError } from "../errors";

type KeyRow = { user_id: string; key_id: string; encryption_public_key: string; signing_public_key: string; backup_iv: string; backup_ciphertext: string };
function decode(value: unknown, min: number, max = min): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new AppError(400, "invalid_encryption", "Invalid encrypted data encoding");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length < min || bytes.length > max || bytes.toString("base64url") !== value) throw new AppError(400, "invalid_encryption", "Invalid encrypted data length or encoding");
  return bytes;
}
function publicKey(value: string): KeyObject {
  try {
    const bytes = decode(value, 91), key = createPublicKey({ key: bytes, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1" || !key.export({ format: "der", type: "spki" }).equals(bytes)) throw new Error();
    return key;
  } catch { throw new AppError(400, "invalid_encryption", "Use a valid P-256 public key"); }
}
function publicIdentity(row: KeyRow): PublicIdentity { return { userId: row.user_id, keyId: row.key_id, encryptionPublicKey: row.encryption_public_key, signingPublicKey: row.signing_public_key }; }
export function messagingIdentity(userId: string): PublicIdentity | null {
  const row = one<KeyRow>("SELECT * FROM messaging_keys WHERE user_id=?", userId);
  return row ? publicIdentity(row) : null;
}
export function messagingBackup(userId: string): IdentityBackup | null {
  const row = one<KeyRow>("SELECT * FROM messaging_keys WHERE user_id=?", userId);
  return row ? { ...publicIdentity(row), backupIv: row.backup_iv, backupCiphertext: row.backup_ciphertext } : null;
}
export function registerMessagingIdentity(userId: string, input: IdentityRegistration): PublicIdentity {
  decode(input.keyId, 32); decode(input.backupIv, 12); decode(input.backupCiphertext, 17, 4096);
  publicKey(input.encryptionPublicKey); const signing = publicKey(input.signingPublicKey);
  const identity: PublicIdentity = { userId, keyId: input.keyId, encryptionPublicKey: input.encryptionPublicKey, signingPublicKey: input.signingPublicKey };
  if (createHash("sha256").update(identityBytes(identity)).digest("base64url") !== input.keyId || !verify("sha256", registrationBytes(userId, input), { key: signing, dsaEncoding: "ieee-p1363" }, decode(input.proof, 64))) throw new AppError(400, "invalid_encryption", "Encryption identity proof is invalid");
  return transaction(() => {
    const existing = messagingBackup(userId);
    if (existing) {
      if (existing.keyId !== input.keyId || existing.backupIv !== input.backupIv || existing.backupCiphertext !== input.backupCiphertext) throw new AppError(409, "encryption_identity_exists", "Encrypted messaging is already enabled. Restore its keys with your recovery code.");
      return messagingIdentity(userId)!;
    }
    run("INSERT INTO messaging_keys VALUES(?,?,?,?,?,?,?)", userId, input.keyId, input.encryptionPublicKey, input.signingPublicKey, input.backupIv, input.backupCiphertext, Date.now());
    return identity;
  });
}
export function validateEncryptedEnvelope(context: MessageContext, input: EncryptedEnvelope): void {
  const fields = ["version", "clientId", "senderKeyId", "recipientKeyId", "ephemeralPublicKey", "salt", "recipientIv", "recipientCiphertext", "senderIv", "senderCiphertext", "signature"];
  if (!input || typeof input !== "object" || Object.keys(input).length !== fields.length || Object.keys(input).some(k => !fields.includes(k))) throw new AppError(400, "invalid_encryption", "Only encrypted message fields are accepted");
  if (!input || input.version !== DM_PROTOCOL || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.clientId)) throw new AppError(400, "invalid_encryption", "Invalid encrypted message version or client ID");
  decode(input.senderKeyId, 32); decode(input.recipientKeyId, 32); publicKey(input.ephemeralPublicKey);
  decode(input.salt, 32); decode(input.senderIv, 12); decode(input.recipientIv, 12);
  decode(input.senderCiphertext, 17, 40016); decode(input.recipientCiphertext, 17, 40016);
  const sender = messagingIdentity(context.senderId), recipient = messagingIdentity(context.recipientId);
  if (!sender || !recipient) throw new AppError(409, "encryption_not_ready", "Both participants must enable encrypted messaging before sending");
  if (sender.keyId !== input.senderKeyId || recipient.keyId !== input.recipientKeyId) throw new AppError(409, "encryption_key_changed", "Encryption keys do not match the registered participants");
  if (!verify("sha256", envelopeBytes(context, input), { key: publicKey(sender.signingPublicKey), dsaEncoding: "ieee-p1363" }, decode(input.signature, 64))) throw new AppError(400, "invalid_encryption", "Encrypted message signature is invalid");
}
