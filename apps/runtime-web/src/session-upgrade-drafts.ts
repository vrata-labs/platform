export interface SessionNoteDraft {
  scope: "shared" | "private";
  content: string;
}

type TabStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// No tokens, identity proof, or private-note authorisation are stored here.
// These are editable-text copies in the same tab, never automatically published.
export function createSessionUpgradeStorage(storage: () => TabStorage, roomId: string, buildId: string) {
  const prefix = `vrata.session-upgrade.${encodeURIComponent(roomId)}`;
  const draftKey = `${prefix}.drafts`;
  const reloadKey = `${prefix}.reload`;
  function readDrafts(): SessionNoteDraft[] {
    try {
      const value: unknown = JSON.parse(storage().getItem(draftKey) ?? "[]");
      if (!Array.isArray(value) || value.length > 2) return [];
      return value.filter((draft): draft is SessionNoteDraft => Boolean(draft)
        && (draft.scope === "shared" || draft.scope === "private")
        && typeof draft.content === "string" && draft.content.length <= 20_000);
    } catch { return []; }
  }
  return {
    readDrafts,
    saveDraft(draft: SessionNoteDraft): boolean {
      if (draft.content.length > 20_000) return false;
      try {
        const drafts = readDrafts().filter(item => item.scope !== draft.scope);
        storage().setItem(draftKey, JSON.stringify([...drafts, draft]));
        return true;
      } catch { return false; }
    },
    discardDrafts(): boolean {
      try { storage().removeItem(draftKey); return true; } catch { return false; }
    },
    alreadyReloaded(): boolean {
      try { return storage().getItem(reloadKey) === buildId; } catch { return false; }
    },
    recordReload(): void {
      try { storage().setItem(reloadKey, buildId); } catch { /* UI still prevents a double click. */ }
    }
  };
}
