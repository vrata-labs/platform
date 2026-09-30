export interface RoomIdentityTabStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The public participant ID is never evidence of continuity. Only this
 * room-keyed, tab-local possession credential can resume a v2 session. */
export function createRoomIdentityTab(storage: RoomIdentityTabStorage, roomId: string) {
  const base = `vrata.identity.v2.${encodeURIComponent(roomId)}`;
  const credentialPattern = /^ri2\.[A-Za-z0-9_-]{1,3000}\.[A-Za-z0-9_-]{43}$/;
  const waitingPattern = /^rw2\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/;
  let inMemoryIdentity: string | null = null;
  let inMemoryWaiting: string | null = null;
  const read = (key: string, pattern: RegExp, fallback: string | null) => {
    if (fallback) return fallback;
    try {
      const value = storage.getItem(key);
      return value && value.length <= 4096 && pattern.test(value) ? value : fallback;
    } catch { return fallback; }
  };
  return {
    identityCredential: () => read(base, credentialPattern, inMemoryIdentity),
    waitingCredential: () => read(`${base}.waiting`, waitingPattern, inMemoryWaiting),
    rememberIdentity(credential: string) {
      if (!credentialPattern.test(credential) || credential.length > 4096) throw new Error("invalid_room_identity_credential");
      inMemoryIdentity = credential;
      inMemoryWaiting = null;
      try { storage.setItem(base, credential); storage.removeItem(`${base}.waiting`); }
      catch { /* A storage-denied tab retains only the in-memory identity. */ }
    },
    rememberWaiting(credential: string) {
      if (!waitingPattern.test(credential)) throw new Error("invalid_waiting_identity_credential");
      inMemoryWaiting = credential;
      try { storage.setItem(`${base}.waiting`, credential); }
      catch { /* The pending proof remains usable for this open page only. */ }
    },
    discardWaiting() {
      inMemoryWaiting = null;
      try { storage.removeItem(`${base}.waiting`); } catch { /* ignored */ }
    }
  };
}
