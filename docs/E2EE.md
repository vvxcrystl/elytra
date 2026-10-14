# Encrypted direct messages

Elytra encrypts DM bodies on the sender's device and decrypts them on the participants' devices. The API and database contain signed ciphertext, not message text. Public posts are still public. Participants, timestamps, read markers, approximate message sizes, and public encryption identities remain visible to the server.

The browser uses the [W3C Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/) for P-256 ECDH, HKDF-SHA-256, AES-256-GCM, and ECDSA with SHA-256. Crypto code is in `src/lib/e2ee.ts`, the wire contract in `src/lib/e2ee-contract.ts`, browser key storage in `src/lib/e2ee-store.ts`, and key lifecycle/pinning in `src/components/messages/encryption.ts`.

## Setup and recovery

On first opening Messages, generate keys, save the recovery code in a password manager or download it, and acknowledge that it was saved. Keys are only published after that acknowledgement. Each account has separate encryption and signing key pairs.

Private keys are reimported as nonextractable `CryptoKey` objects and stored in IndexedDB. Decrypted message bodies live only in component memory; the app does not save them to IndexedDB, localStorage, sessionStorage, URLs, logs, or a service worker. Leaving Messages clears the in-memory identity; the device's key handles remain available for the next visit.

The client generates an independent 32-byte recovery secret, shown as a 43-character base64url code. It encrypts a backup of the private keys with AES-256-GCM and binds it to the account and public identity using additional authenticated data. Only the encrypted backup is uploaded. The recovery code is never uploaded, and the account password is not used to encrypt the backup. This matters because the login server receives account passwords.

On another browser/device, sign in and enter the saved recovery code. The device decrypts the backup, checks that both recovered private keys match the published public keys, imports nonextractable key handles, and saves them locally. Incorrect recovery codes and altered backups fail closed. The app cannot recover a lost code. Existing identities cannot be silently overwritten or reset.

## Encryption and authentication

The wire version is `elytra-dm-e2ee-v1`. An envelope contains:

```text
version, clientId, senderKeyId, recipientKeyId,
ephemeralPublicKey, salt,
recipientIv, recipientCiphertext,
senderIv, senderCiphertext,
signature
```

Every message uses a fresh ephemeral P-256 ECDH key pair, a random 32-byte HKDF salt, and separate random 12-byte AES-GCM nonces for the recipient and sender copies. The sender derives an AES-256 key separately for each copy using ECDH with that copy's owner's public encryption key and HKDF-SHA-256. The ephemeral private key is not persisted. Copies are encrypted with 128-bit authentication tags. The sender copy lets the sender read history on any device that restores their identity.

The HKDF info and AES-GCM additional authenticated data are the UTF-8 JSON encoding of this fixed-order array:

```text
[version, "payload", conversationId, senderId, recipientId,
 clientId, senderKeyId, recipientKeyId, copyOwnerId]
```

The ECDSA signature covers this fixed-order array, binding both encrypted copies to the conversation, participants, and client-generated message ID:

```text
[version, conversationId, senderId, recipientId,
 clientId, senderKeyId, recipientKeyId, ephemeralPublicKey, salt,
 recipientIv, recipientCiphertext, senderIv, senderCiphertext]
```

The signature is the WebCrypto 64-byte IEEE-P1363 `r || s` form. All binary fields use canonical unpadded base64url; public keys use SPKI DER. `keyId` is SHA-256 of the canonical identity array `[version, userId, encryptionPublicKey, signingPublicKey]`, encoded as base64url. Key registration is self-signed over the account ID, public keys, key ID, and encrypted backup.

The API verifies the registered sender's signature, confirms both key IDs belong to the conversation participants, checks all lengths/encodings/public-key curves, and rejects plaintext or additional envelope fields. It cannot decrypt or independently measure the plaintext's character length. The browser enforces 1–10,000 Unicode code points; the server permits at most 40,016 ciphertext bytes per copy. Message requests allow up to 128 KiB, including both copies.

The client verifies the signature before decryption. Changing the conversation, participants, ciphertext, nonce, or signature causes verification/decryption to fail. Failed messages display an explicit unreadable-message notice; there is no plaintext fallback. The database has no DM `content` column. A unique `(conversation_id, sender_id, client_id)` constraint and signed envelope checks prevent duplicate retries; conflicting payloads return 409.

## Contact verification

Each device pins the first encryption identity it observes for a contact. Future changes stop sending rather than silently replacing the pin. The conversation's Verify encryption action displays a shared SHA-256 safety number over both participants' IDs and key IDs, sorted by participant ID. Both parties see the same number.

Compare this number in person, on a trusted call, or through another trusted channel, then mark it verified. Do not use Elytra messages for that comparison. Before this check, the first identity is trusted on first use; it is not independently authenticated against an active attacker controlling the key directory. Verification state and pins are device-local and do not leak contact verification to the server.

## Existing plaintext messages

Messages written before E2EE cannot be retroactively end-to-end encrypted using keys the server never held. On upgrading, the migration removes their bodies, preserves IDs/participants/timestamps/read markers, and marks them `legacyRemoved: true` with no ciphertext. The UI displays a removal notice.

The migration enables SQLite `secure_delete`, rebuilds the messages table, checkpoints/truncates the WAL, runs `VACUUM`, and checkpoints again. A durable pending marker makes interrupted cleanup retryable; a busy checkpoint fails startup closed until readers release the database. This follows SQLite's [secure-delete and checkpoint behavior](https://www.sqlite.org/pragma.html). Tests scan both the database and WAL bytes for the old plaintext markers.

This cleanup applies to the active SQLite database and its SQLite journal files. It cannot erase historical backups, filesystem snapshots, copied databases, previously exported messages, or forensic remnants managed outside SQLite. Those must be removed through their own storage/backup systems if they contain old plaintext.

## Scope and limits

This implementation provides encrypted one-to-one text bodies, sender authentication, encrypted key recovery, and contact verification. It does not implement a Double Ratchet, forward secrecy against later compromise of a participant's persistent private key, post-compromise recovery, group messaging, or an independently audited messaging protocol. Fresh ephemeral keys do not make archived messages safe after a recipient's persistent decryption key is compromised.

Use HTTPS in deployment. Browser-delivered application code and the device/browser profile must be trusted: malicious same-origin scripts can use key handles or read displayed plaintext even though those handles cannot be exported. IndexedDB keys are not a hardware-backed vault. Authentication/password recovery alone cannot recover DM keys.

## Validation

`npm run test:e2ee` checks real sender/recipient decryption, third-party rejection, nonextractable keys, random ciphertext, tampering/context substitution, encrypted backup recovery, Unicode bounds, retry deduplication, and legacy database/WAL erasure. `npm run test:api` covers all 59 REST operations, including the ciphertext contract and key endpoints. Browser verification additionally checks setup, IndexedDB persistence, recovery on a separate browser context, fingerprint pinning/verification, and ciphertext-only request/response bodies.
