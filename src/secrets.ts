/** Obsidian keychain ids are lowercase letters, digits, and dashes. */
const KEYCHAIN_SECRET_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface KeychainStore {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

/** Resolve a settings value that is either a keychain id or a legacy plaintext secret. */
export function readKeychainSecret(storage: KeychainStore | null | undefined, stored: string): string {
  const raw = (stored || "").trim();
  if (!raw) return "";
  if (!storage) return raw;
  try {
    const value = storage.getSecret(raw);
    if (value != null && value !== "") return value;
  } catch {
    return KEYCHAIN_SECRET_ID.test(raw) ? "" : raw;
  }
  if (!KEYCHAIN_SECRET_ID.test(raw)) return raw;
  return "";
}

/**
 * Move a plaintext secret into the keychain.
 * Returns the id to persist in plugin settings. Leaves the stored value unchanged
 * when it is already an id, or when the keychain is unavailable.
 */
export function migratePlaintextToKeychain(
  storage: KeychainStore | null | undefined,
  stored: string,
  preferredId: string
): string {
  const raw = (stored || "").trim();
  if (!raw || !storage) return raw;
  try {
    if (storage.getSecret(raw) != null) return raw;
    if (KEYCHAIN_SECRET_ID.test(raw)) return raw;
    const id = claimSecretId(storage, preferredId, raw);
    if (storage.getSecret(id) !== raw) storage.setSecret(id, raw);
    return id;
  } catch {
    return raw;
  }
}

function claimSecretId(storage: KeychainStore, preferredId: string, secret: string): string {
  const existing = storage.getSecret(preferredId);
  if (existing == null || existing === secret) return preferredId;
  const imported = `${preferredId}-imported`;
  const importedExisting = storage.getSecret(imported);
  if (importedExisting == null || importedExisting === secret) return imported;
  return `${preferredId}-${Date.now().toString(36)}`;
}
