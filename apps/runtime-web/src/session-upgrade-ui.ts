import type { IdentityRequirementReason } from "@vrata/shared-types";
import { describeIdentityRequirement, type createSessionUpgradeGate } from "./session-upgrade.js";
import { createSessionUpgradeStorage, type SessionNoteDraft } from "./session-upgrade-drafts.js";

export function mountSessionUpgradeUi(input: {
  gate: ReturnType<typeof createSessionUpgradeGate>;
  roomId: string;
  buildId: string;
  document: Document;
  storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem">;
  getUnsavedNote: () => SessionNoteDraft | null;
  stopSession: (reason: IdentityRequirementReason) => void;
  reload: () => void;
  download: (blob: Blob, filename: string) => void;
  confirmDiscard: () => boolean;
}) {
  const element = <T extends HTMLElement>(id: string) => input.document.getElementById(id) as T;
  const dialog = element<HTMLDialogElement>("session-upgrade-dialog");
  const title = element("session-upgrade-title");
  const message = element("session-upgrade-message");
  const reloadButton = element<HTMLButtonElement>("session-upgrade-reload");
  const draftPanel = element("session-upgrade-drafts");
  const recoveryPanel = input.document.getElementById("room-recovery-panel");
  const recoveryHome = recoveryPanel?.parentElement;
  const draftList = element("session-upgrade-draft-list");
  const draftStatus = element("session-upgrade-draft-status");
  const discardButton = element<HTMLButtonElement>("session-upgrade-discard-drafts");
  const draftHome = draftPanel.parentElement!;
  const store = createSessionUpgradeStorage(input.storage, input.roomId, input.buildId);
  let drafts = store.readDrafts();
  let storageFailed = false;
  let stopped = false;
  let shutdownFailed = false;

  function renderDrafts() {
    draftPanel.hidden = drafts.length === 0;
    draftStatus.textContent = storageFailed
      ? "This browser could not keep the draft for reload. Copy or download it before updating."
      : "Kept only in this tab, not saved to the room. Copy or download before closing the tab. Nothing is published automatically.";
    draftList.replaceChildren();
    for (const draft of drafts) {
      const label = input.document.createElement("label");
      const editor = input.document.createElement("textarea");
      editor.id = `session-upgrade-draft-${draft.scope}`;
      label.htmlFor = editor.id;
      label.textContent = draft.scope === "shared" ? "Shared note draft" : "Private note draft";
      editor.readOnly = true;
      editor.rows = 4;
      editor.value = draft.content;
      const download = input.document.createElement("button");
      download.type = "button";
      download.textContent = `Download ${draft.scope} draft`;
      download.onclick = () => input.download(new Blob([draft.content], { type: "text/markdown;charset=utf-8" }), `notes-draft-${draft.scope}.md`);
      draftList.append(label, editor, download);
    }
  }

  function onRequired(reason: IdentityRequirementReason) {
    if (!stopped) {
      stopped = true;
      // Capture before shutdown invalidates pending note loads/saves.
      const draft = input.getUnsavedNote();
      if (draft) preserveDraft(draft);
      try { input.stopSession(reason); }
      catch { shutdownFailed = true; }
    }
    title.textContent = describeIdentityRequirement(reason);
    const recovery = reason === "identity_recovery_required";
    const repeated = store.alreadyReloaded();
    message.textContent = recovery
      ? "This identity cannot be renewed. Contact the room administrator for secure access recovery. An old participant ID or session token cannot restore ownership."
      : repeated
        ? "Updating did not restore access. A compatible app may not be deployed yet. Try a browser hard refresh or contact the room administrator."
        : "The server requires a new room session. Update the app and enter again using your invitation. The room's saved materials remain on the server. Host or owner access may require administrator recovery.";
    if (shutdownFailed) message.textContent += " Some local cleanup failed. Save your drafts and close this tab before rejoining.";
    reloadButton.hidden = recovery || repeated;
    dialog.append(draftPanel);
    if (recoveryPanel) {
      dialog.append(recoveryPanel);
      (recoveryPanel as HTMLDetailsElement).open = reason === "identity_recovery_required";
    }
    renderDrafts();
    if (!dialog.open) dialog.showModal();
    (reloadButton.hidden ? title : reloadButton).focus();
  }

  reloadButton.onclick = () => {
    if (input.gate.reason !== "identity_upgrade_required" || store.alreadyReloaded() || reloadButton.disabled) return;
    if (storageFailed && !input.confirmDiscard()) return;
    store.recordReload();
    reloadButton.disabled = true;
    // Reload updates the bundle. v2 issuance/adoption is responsible for the
    // identity transition; S1 must not destroy legacy owner/private-note IDs.
    input.reload();
  };
  discardButton.onclick = () => {
    if (!store.discardDrafts()) return;
    drafts = [];
    storageFailed = false;
    renderDrafts();
  };
  const preventDismiss = (event: Event) => event.preventDefault();
  dialog.addEventListener("cancel", preventDismiss);
  renderDrafts();
  const uninstall = input.gate.install(onRequired);
  function preserveDraft(draft: SessionNoteDraft): boolean {
    if (draft.content.length > 20_000) return false;
    storageFailed = !store.saveDraft(draft);
    drafts = [...drafts.filter(item => item.scope !== draft.scope), draft];
    renderDrafts();
    return true;
  }
  function dispose() {
    uninstall();
    dialog.removeEventListener("cancel", preventDismiss);
    reloadButton.onclick = null;
    discardButton.onclick = null;
    if (dialog.open) dialog.close();
    draftHome.append(draftPanel);
    if (recoveryPanel && recoveryHome) recoveryHome.append(recoveryPanel);
  }
  return { dispose, preserveDraft };
}
