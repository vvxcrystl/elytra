import type { ClientIdentity } from "./e2ee";
import type { PublicIdentity } from "./e2ee-contract";

/** Stores nonextractable CryptoKeys and identity pins. Never stores message bodies. */
type Pin = { id: string; keyId: string; verified: boolean };
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("elytra-encrypted-messaging", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("identities", { keyPath: "userId" });
      request.result.createObjectStore("pins", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Encrypted key storage is unavailable in this browser"));
    request.onblocked = () => reject(new Error("Close other Elytra tabs to update encrypted key storage"));
  });
}
export async function loadIdentity(userId: string): Promise<ClientIdentity | null> {
  const db = await database();
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction("identities", "readonly"), request = tx.objectStore("identities").get(userId);
    request.onsuccess = () => resolve(request.result ?? null); request.onerror = () => reject(new Error("Unable to read this device's encryption keys"));
  }); } finally { db.close(); }
}
export async function saveIdentity(identity: ClientIdentity): Promise<void> {
  if (identity.encryptionPrivateKey.extractable || identity.signingPrivateKey.extractable) throw new Error("Private messaging keys must not be exportable");
  const db = await database();
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("identities", "readwrite"); tx.objectStore("identities").put(identity);
    tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(new Error("Unable to save this device's encryption keys. Keep your recovery code and retry."));
  }); } finally { db.close(); }
}
/** One read/write transaction prevents concurrent first-contact pins from overwriting each other. */
export async function checkPin(viewerId: string, peer: PublicIdentity, verify = false): Promise<Pin> {
  const db = await database(), id = JSON.stringify([viewerId, peer.userId]);
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction("pins", "readwrite"), store = tx.objectStore("pins"), request = store.get(id);
    let result: Pin;
    request.onsuccess = () => {
      const previous = request.result as Pin | undefined;
      if (previous && previous.keyId !== peer.keyId) {
        reject(new Error("This person's encryption keys changed. Sending is stopped; verify their identity outside Elytra.")); tx.abort(); return;
      }
      result = { id, keyId: peer.keyId, verified: previous?.verified || verify };
      store.put(result);
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () => reject(new Error("Unable to verify stored contact keys"));
  }); } finally { db.close(); }
}
