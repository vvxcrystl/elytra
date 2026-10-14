# Encrypted direct messages

Elytra encrypts DM bodies on the sender's device and decrypts them on the participants' devices. The API and database hold signed ciphertext, never message text. Public posts stay public.

The server can still see:

- who the participants are
- timestamps and read markers
- approximate message sizes
- public encryption identities

The browser uses the [W3C Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/) for P-256 ECDH, HKDF-SHA-256, AES-256-GCM, and ECDSA with SHA-256. The code is split across these files:

- `src/lib/e2ee.ts` has the crypto.
- `src/lib/e2ee-contract.ts` defines the wire contract.
- `src/lib/e2ee-store.ts` stores keys in the browser.
- `src/components/messages/encryption.ts` handles the key lifecycle and pinning.

## Setup and recovery

The first time you open Messages, the app generates your keys. You save the recovery code in a password manager or download it, then confirm you saved it. The app publishes your keys only after that confirmation. Each account has one encryption key pair and one signing key pair.

The app reimports the private keys as nonextractable `CryptoKey` objects and stores them in IndexedDB. Decrypted message bodies exist only in component memory. The app never writes them to IndexedDB, localStorage, sessionStorage, URLs, logs, or a service worker. Leaving Messages clears the in-memory identity. The device keeps its key handles for your next visit.

The client generates an independent 32-byte recovery secret and shows it as a 43-character base64url code. That secret encrypts a backup of the private keys with AES-256-GCM. Additional authenticated data ties the backup to the account and its public identity. The app uploads only the encrypted backup. It never uploads the recovery code, and it doesn't use the account password to encrypt the backup, because the login server receives account passwords.

To use another browser or device, sign in and enter the saved recovery code. The device then:

1. Decrypts the backup.
2. Checks that both recovered private keys match the published public keys.
3. Imports them as nonextractable key handles and saves them locally.

A wrong recovery code or an altered backup fails with an error. The app cannot recover a lost code. Nobody can silently overwrite or reset an existing identity.

## Encryption and authentication

The wire version is `elytra-dm-e2ee-v1`. An envelope contains:

```text
version, clientId, senderKeyId, recipientKeyId,
ephemeralPublicKey, salt,
recipientIv, recipientCiphertext,
senderIv, senderCiphertext,
signature
```

Each message has two encrypted copies, one for the recipient and one for the sender. The sender copy lets the sender read their history on any device that restores their identity.

For each message, the sender generates:

- a fresh ephemeral P-256 ECDH key pair, which is never persisted
- a random 32-byte HKDF salt
- a random 12-byte AES-GCM nonce for each copy

The sender derives a separate AES-256 key for each copy. Each derivation runs ECDH with the public encryption key of the person who owns that copy, then HKDF-SHA-256. Both copies use 128-bit authentication tags.

The HKDF info and the AES-GCM additional authenticated data are the UTF-8 JSON encoding of this array, in this order:

```text
[version, "payload", conversationId, senderId, recipientId,
 clientId, senderKeyId, recipientKeyId, copyOwnerId]
```

The ECDSA signature covers the array below, in this order. It binds both encrypted copies to the conversation, the participants, and the client-generated message ID:

```text
[version, conversationId, senderId, recipientId,
 clientId, senderKeyId, recipientKeyId, ephemeralPublicKey, salt,
 recipientIv, recipientCiphertext, senderIv, senderCiphertext]
```

Encoding rules:

- The signature is WebCrypto's 64-byte IEEE-P1363 `r || s` form.
- Binary fields use canonical unpadded base64url.
- Public keys use SPKI DER.
- `keyId` is the base64url SHA-256 of the identity array `[version, userId, encryptionPublicKey, signingPublicKey]`.
- Key registration is self-signed over the account ID, the public keys, the key ID, and the encrypted backup.

### What the server checks

The API verifies the registered sender's signature and confirms that both key IDs belong to the conversation's participants. It checks every length, encoding, and public-key curve, and it rejects plaintext and extra envelope fields.

The server can't decrypt a message or measure its character length. The browser enforces 1 to 10,000 Unicode code points. The server allows at most 40,016 ciphertext bytes per copy and 128 KiB per request, including both copies.

### What the client checks

The client verifies the signature before it decrypts. If anyone changes the conversation, participants, ciphertext, nonce, or signature, verification or decryption fails. The message then shows an unreadable-message notice. There is no plaintext fallback.

The database has no DM `content` column. A unique `(conversation_id, sender_id, client_id)` constraint, together with the signed envelope checks, prevents duplicate retries. A retry with a conflicting payload returns 409.

## Contact verification

Each device pins the first encryption identity it sees for a contact. If the identity later changes, the app stops sending instead of replacing the pin.

The Verify encryption action in a conversation shows a safety number. It is a SHA-256 hash over both participants' IDs and key IDs, sorted by participant ID, so both people see the same number. Compare it in person, on a trusted call, or over another trusted channel, then mark it verified. Don't compare it through Elytra messages.

Until you verify, the app trusts the first identity it saw (trust on first use). That doesn't protect you from an active attacker who controls the key directory. Pins and verification state stay on the device, so the server never learns which contacts you verified.

## Existing plaintext messages

Messages written before E2EE can't be encrypted after the fact, because the server already held them in plaintext. On upgrade, the migration:

- removes their bodies
- keeps IDs, participants, timestamps, and read markers
- marks them `legacyRemoved: true` with no ciphertext

The UI shows a removal notice for these messages.

The cleanup follows SQLite's [secure-delete and checkpoint behavior](https://www.sqlite.org/pragma.html):

1. Enable `secure_delete`.
2. Rebuild the messages table.
3. Checkpoint and truncate the WAL.
4. Run `VACUUM`.
5. Checkpoint again.

A durable pending marker lets an interrupted cleanup resume. If a checkpoint is busy, startup fails until readers release the database. Tests scan both the database and WAL bytes for the old plaintext markers.

The cleanup covers the active SQLite database and its journal files only. It can't erase old backups, filesystem snapshots, copied databases, exported messages, or forensic remnants outside SQLite. If those hold old plaintext, remove them through their own storage or backup systems.

## Scope and limits

This implementation provides:

- encrypted one-to-one text bodies
- sender authentication
- encrypted key recovery
- contact verification

It does not provide:

- a Double Ratchet
- forward secrecy if a participant's persistent private key is later compromised
- post-compromise recovery
- group messaging
- an independent audit of the protocol

The fresh ephemeral keys don't protect archived messages once a recipient's persistent decryption key is compromised.

Use HTTPS in deployment. You must trust the application code the browser receives, and you must trust the device and browser profile. A malicious same-origin script can use key handles or read displayed plaintext, even though it can't export the keys. IndexedDB is not a hardware-backed vault. Password recovery alone can't restore DM keys.

## Validation

`npm run test:e2ee` checks:

- sender and recipient decryption, and rejection of third parties
- nonextractable keys and random ciphertext
- tampering and context substitution
- encrypted backup recovery
- Unicode length bounds
- retry deduplication
- legacy plaintext erasure from the database and WAL

`npm run test:api` covers all 59 REST operations, including the ciphertext contract and the key endpoints.

Browser verification also checks setup, IndexedDB persistence, recovery in a separate browser context, fingerprint pinning and verification, and that request and response bodies contain only ciphertext.
