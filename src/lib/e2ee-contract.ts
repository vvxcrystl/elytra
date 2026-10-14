/** Public wire format. No message text, private key, or recovery code belongs here. */
export const DM_PROTOCOL = "elytra-dm-e2ee-v1";
export const BACKUP_PROTOCOL = "elytra-key-backup-v1";
export type PublicIdentity = {
  userId: string; keyId: string; encryptionPublicKey: string; signingPublicKey: string;
};
export type IdentityRegistration = Omit<PublicIdentity, "userId"> & {
  backupIv: string; backupCiphertext: string; proof: string;
};
export type IdentityBackup = PublicIdentity & { backupIv: string; backupCiphertext: string };
export type EncryptedEnvelope = {
  version: typeof DM_PROTOCOL; clientId: string; senderKeyId: string; recipientKeyId: string;
  ephemeralPublicKey: string; salt: string; recipientIv: string; recipientCiphertext: string;
  senderIv: string; senderCiphertext: string; signature: string;
};
export type MessageContext = { conversationId: string; senderId: string; recipientId: string };
export function identityBytes(identity: PublicIdentity): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify([DM_PROTOCOL, identity.userId, identity.encryptionPublicKey, identity.signingPublicKey]));
}
export function registrationBytes(userId: string, registration: Omit<IdentityRegistration, "proof">): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify([BACKUP_PROTOCOL, userId, registration.keyId, registration.encryptionPublicKey, registration.signingPublicKey, registration.backupIv, registration.backupCiphertext]));
}
export function envelopeBytes(context: MessageContext, envelope: Omit<EncryptedEnvelope, "signature">): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify([DM_PROTOCOL, context.conversationId, context.senderId, context.recipientId, envelope.clientId, envelope.senderKeyId, envelope.recipientKeyId, envelope.ephemeralPublicKey, envelope.salt, envelope.recipientIv, envelope.recipientCiphertext, envelope.senderIv, envelope.senderCiphertext]));
}
export function payloadContext(context: MessageContext, envelope: Pick<EncryptedEnvelope, "clientId" | "senderKeyId" | "recipientKeyId">, copyFor: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify([DM_PROTOCOL, "payload", context.conversationId, context.senderId, context.recipientId, envelope.clientId, envelope.senderKeyId, envelope.recipientKeyId, copyFor]));
}
