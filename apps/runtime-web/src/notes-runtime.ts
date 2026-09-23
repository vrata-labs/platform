import { hasRoomPermission } from "@vrata/shared-types";
import type * as RuntimeApi from "./index.js";
import { nextNotesSaveState, parseSafeMarkdown, type NotesSaveState } from "./notes.js";
import type { createRuntimeDebugState } from "./runtime-debug-state.js";

export interface NotesRuntimeState {
  activeNotesScope: RuntimeApi.RuntimeNoteScope;
  notesSaveState: NotesSaveState;
  notesLastSavedContent: string;
  notesLastUpdatedAt: string | null;
  notesLoadSeq: number;
  notesSaveSeq: number;
  notesAutosaveTimer: number | null;
  notesVersions: RuntimeApi.RuntimeNoteVersionRecord[];
  notesHistoryLoading: boolean;
  notesExportInFlight: boolean;
}

export function createNotesRuntimeState(activeNotesScope: RuntimeApi.RuntimeNoteScope): NotesRuntimeState {
  return {
    activeNotesScope,
    notesSaveState: "idle",
    notesLastSavedContent: "",
    notesLastUpdatedAt: null,
    notesLoadSeq: 0,
    notesSaveSeq: 0,
    notesAutosaveTimer: null,
    notesVersions: [],
    notesHistoryLoading: false,
    notesExportInFlight: false
  };
}

export interface NotesRuntimeElements {
  notesPanelEl: HTMLDivElement;
  notesScopeSelect: HTMLSelectElement;
  notesEditor: HTMLTextAreaElement;
  notesRetrySaveButton: HTMLButtonElement;
  notesStatusEl: HTMLDivElement;
  notesPreviewEl: HTMLDivElement;
  notesVersionSelect: HTMLSelectElement;
  notesRestoreVersionButton: HTMLButtonElement;
  notesExportMarkdownButton: HTMLButtonElement;
  notesExportJsonButton: HTMLButtonElement;
  notesExportRoomJsonButton: HTMLButtonElement;
}

export interface NotesRuntimeContext {
  state: NotesRuntimeState;
  elements: NotesRuntimeElements;
  api: Pick<typeof RuntimeApi,
    | "fetchRoomNote"
    | "listRoomNoteVersions"
    | "saveRoomNote"
    | "restoreRoomNoteVersion"
    | "exportRoomNote"
    | "exportRoomNotesArchive"
  >;
  apiBaseUrl: string;
  roomId: string;
  readonly roomStateAccessToken: string;
  readonly runtimeFlags: { notesEnabled: boolean };
  debugState: {
    access: Pick<ReturnType<typeof createRuntimeDebugState>["access"], "permissions">;
    notes: ReturnType<typeof createRuntimeDebugState>["notes"];
  };
  downloadBlob: (blob: Blob, filename: string) => void;
}

// Read replaceable permissions, feature flags and session tokens when each operation runs.
export function createNotesRuntime(context: NotesRuntimeContext) {
  const { state, apiBaseUrl, roomId, debugState, downloadBlob } = context;
  const {
    notesPanelEl,
    notesScopeSelect,
    notesEditor,
    notesRetrySaveButton,
    notesStatusEl,
    notesPreviewEl,
    notesVersionSelect,
    notesRestoreVersionButton,
    notesExportMarkdownButton,
    notesExportJsonButton,
    notesExportRoomJsonButton
  } = context.elements;
  const {
    fetchRoomNote,
    listRoomNoteVersions,
    saveRoomNote,
    restoreRoomNoteVersion,
    exportRoomNote,
    exportRoomNotesArchive
  } = context.api;

  function canViewNotes(): boolean {
    return context.runtimeFlags.notesEnabled && hasRoomPermission(debugState.access.permissions, "notes.view");
  }

  function canEditNotes(): boolean {
    if (!canViewNotes()) return false;
    return state.activeNotesScope === "private" || hasRoomPermission(debugState.access.permissions, "notes.edit");
  }

  function setNotesSaveState(event: Parameters<typeof nextNotesSaveState>[1], message?: string, errorCode: string | null = null): void {
    state.notesSaveState = nextNotesSaveState(state.notesSaveState, event);
    notesStatusEl.textContent = message ?? notesStatusEl.textContent;
    notesRetrySaveButton.hidden = state.notesSaveState !== "failed";
    debugState.notes = {
      enabled: context.runtimeFlags.notesEnabled,
      scope: state.activeNotesScope,
      saveState: state.notesSaveState,
      canEdit: canEditNotes(),
      contentLength: notesEditor.value.length,
      versionCount: state.notesVersions.length,
      exportInFlight: state.notesExportInFlight,
      updatedAt: state.notesLastUpdatedAt,
      errorCode
    };
  }

  function renderNotesPreview(): void {
    const blocks = parseSafeMarkdown(notesEditor.value);
    const children: Node[] = [];
    let list: HTMLUListElement | null = null;

    const flushList = (): void => {
      if (list) {
        children.push(list);
        list = null;
      }
    };

    for (const block of blocks) {
      if (block.type !== "listItem") flushList();
      if (block.type === "heading") {
        const heading = document.createElement(`h${block.level}`);
        heading.textContent = block.text;
        children.push(heading);
      } else if (block.type === "paragraph") {
        const paragraph = document.createElement("p");
        paragraph.textContent = block.text;
        children.push(paragraph);
      } else if (block.type === "listItem") {
        list ??= document.createElement("ul");
        const item = document.createElement("li");
        item.textContent = block.text;
        list.append(item);
      } else {
        const code = document.createElement("pre");
        code.textContent = block.text;
        children.push(code);
      }
    }
    flushList();

    if (children.length === 0) {
      const placeholder = document.createElement("p");
      placeholder.textContent = "No notes yet.";
      children.push(placeholder);
    }
    notesPreviewEl.replaceChildren(...children);
    debugState.notes.contentLength = notesEditor.value.length;
  }

  function renderNotesHistoryUi(): void {
    const visible = context.runtimeFlags.notesEnabled && canViewNotes();
    const selectedVersionId = notesVersionSelect.value;
    notesVersionSelect.replaceChildren(
      ...(state.notesVersions.length > 0
        ? state.notesVersions.map((version, index) => {
          const option = document.createElement("option");
          option.value = version.versionId;
          option.textContent = `${index === 0 ? "Current" : `Version ${state.notesVersions.length - index}`} - ${version.action} - ${new Date(version.createdAt).toLocaleString()}`;
          option.selected = version.versionId === selectedVersionId;
          return option;
        })
        : [new Option("No versions", "")])
    );
    if (selectedVersionId && state.notesVersions.some((version) => version.versionId === selectedVersionId)) {
      notesVersionSelect.value = selectedVersionId;
    }
    notesVersionSelect.disabled = !visible || state.notesHistoryLoading || state.notesVersions.length === 0;
    notesRestoreVersionButton.disabled = !visible || !canEditNotes() || state.notesHistoryLoading || state.notesVersions.length === 0;
    notesExportMarkdownButton.disabled = !visible || state.notesExportInFlight;
    notesExportJsonButton.disabled = !visible || state.notesExportInFlight;
    notesExportRoomJsonButton.disabled = !visible || state.notesExportInFlight;
    debugState.notes.versionCount = state.notesVersions.length;
    debugState.notes.exportInFlight = state.notesExportInFlight;
  }

  function syncNotesAccessUi(): void {
    const visible = context.runtimeFlags.notesEnabled && canViewNotes();
    notesPanelEl.hidden = !visible;
    notesEditor.disabled = !visible || !canEditNotes() || state.notesSaveState === "loading";
    notesScopeSelect.disabled = !visible || state.notesSaveState === "loading";
    if (!visible) {
      notesStatusEl.textContent = context.runtimeFlags.notesEnabled ? "Notes permission required" : "Notes disabled";
    } else if (!canEditNotes()) {
      notesStatusEl.textContent = "Notes read-only";
    }
    debugState.notes.enabled = context.runtimeFlags.notesEnabled;
    debugState.notes.canEdit = canEditNotes();
    renderNotesHistoryUi();
  }

  function notesErrorCode(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.split(":").slice(0, 3).join(":") || "notes_error";
  }

  async function loadActiveNote(): Promise<void> {
    if (!context.runtimeFlags.notesEnabled || !canViewNotes()) {
      syncNotesAccessUi();
      return;
    }
    const loadSeq = ++state.notesLoadSeq;
    setNotesSaveState("load", "Notes loading...");
    syncNotesAccessUi();
    try {
      const note = await fetchRoomNote(apiBaseUrl, roomId, state.activeNotesScope, context.roomStateAccessToken);
      if (loadSeq !== state.notesLoadSeq) return;
      notesEditor.value = note.content;
      state.notesLastSavedContent = note.content;
      state.notesLastUpdatedAt = note.updatedAt;
      setNotesSaveState("load_ok", note.updatedAt ? "Notes saved" : "Notes ready");
      renderNotesPreview();
      await loadActiveNoteVersions();
      syncNotesAccessUi();
    } catch (error) {
      if (loadSeq !== state.notesLoadSeq) return;
      const code = notesErrorCode(error);
      console.warn("notes_load_failed", error);
      setNotesSaveState("save_failed", "Notes unavailable", code);
      syncNotesAccessUi();
    }
  }

  async function loadActiveNoteVersions(): Promise<void> {
    if (!context.runtimeFlags.notesEnabled || !canViewNotes()) {
      state.notesVersions = [];
      renderNotesHistoryUi();
      return;
    }
    state.notesHistoryLoading = true;
    renderNotesHistoryUi();
    try {
      state.notesVersions = await listRoomNoteVersions(apiBaseUrl, roomId, state.activeNotesScope, context.roomStateAccessToken);
    } catch (error) {
      console.warn("notes_versions_load_failed", error);
      state.notesVersions = [];
    } finally {
      state.notesHistoryLoading = false;
      renderNotesHistoryUi();
    }
  }

  function scheduleNotesAutosave(delayMs = 650): void {
    if (!context.runtimeFlags.notesEnabled || !canEditNotes()) {
      syncNotesAccessUi();
      return;
    }
    if (state.notesAutosaveTimer !== null) {
      window.clearTimeout(state.notesAutosaveTimer);
    }
    setNotesSaveState("edit", "Notes pending save");
    renderNotesPreview();
    state.notesAutosaveTimer = window.setTimeout(() => {
      state.notesAutosaveTimer = null;
      void saveActiveNote();
    }, delayMs);
  }

  async function saveActiveNote(): Promise<void> {
    if (!context.runtimeFlags.notesEnabled || !canEditNotes()) {
      syncNotesAccessUi();
      return;
    }
    const content = notesEditor.value;
    if (content === state.notesLastSavedContent) {
      setNotesSaveState("save_ok", state.notesLastUpdatedAt ? "Notes saved" : "Notes ready");
      return;
    }
    const saveSeq = ++state.notesSaveSeq;
    setNotesSaveState("save_start", "Saving notes...");
    try {
      const note = await saveRoomNote(apiBaseUrl, roomId, state.activeNotesScope, context.roomStateAccessToken, content);
      if (saveSeq !== state.notesSaveSeq) return;
      state.notesLastSavedContent = content;
      state.notesLastUpdatedAt = note.updatedAt;
      setNotesSaveState("save_ok", "Notes saved");
      void loadActiveNoteVersions();
      if (notesEditor.value !== content) {
        scheduleNotesAutosave();
      }
    } catch (error) {
      if (saveSeq !== state.notesSaveSeq) return;
      const code = notesErrorCode(error);
      console.warn("notes_save_failed", error);
      setNotesSaveState("save_failed", "Notes save failed; retry available", code);
    }
  }

  async function restoreSelectedNoteVersion(): Promise<void> {
    const versionId = notesVersionSelect.value;
    if (!versionId || !canEditNotes()) return;
    const selected = state.notesVersions.find((version) => version.versionId === versionId);
    if (!selected) return;
    if (!window.confirm(`Restore notes version from ${new Date(selected.createdAt).toLocaleString()}?`)) return;
    try {
      setNotesSaveState("save_start", "Restoring notes version...");
      const note = await restoreRoomNoteVersion(apiBaseUrl, roomId, state.activeNotesScope, context.roomStateAccessToken, versionId);
      notesEditor.value = note.content;
      state.notesLastSavedContent = note.content;
      state.notesLastUpdatedAt = note.updatedAt;
      renderNotesPreview();
      setNotesSaveState("save_ok", "Notes version restored");
      await loadActiveNoteVersions();
    } catch (error) {
      console.warn("notes_restore_failed", error);
      setNotesSaveState("save_failed", "Notes restore failed", notesErrorCode(error));
    }
  }

  async function exportActiveNote(format: "markdown" | "json"): Promise<void> {
    if (!canViewNotes()) return;
    state.notesExportInFlight = true;
    renderNotesHistoryUi();
    try {
      notesStatusEl.textContent = `Exporting notes ${format}...`;
      const download = await exportRoomNote(apiBaseUrl, roomId, state.activeNotesScope, context.roomStateAccessToken, format);
      downloadBlob(download.blob, download.filename);
      notesStatusEl.textContent = `Notes exported: ${download.filename}`;
    } catch (error) {
      console.warn("notes_export_failed", error);
      setNotesSaveState("save_failed", "Notes export failed", notesErrorCode(error));
    } finally {
      state.notesExportInFlight = false;
      renderNotesHistoryUi();
    }
  }

  async function exportRoomNotesJson(): Promise<void> {
    if (!canViewNotes()) return;
    state.notesExportInFlight = true;
    renderNotesHistoryUi();
    try {
      notesStatusEl.textContent = "Exporting room notes JSON...";
      const download = await exportRoomNotesArchive(apiBaseUrl, roomId, context.roomStateAccessToken, "json");
      downloadBlob(download.blob, download.filename);
      notesStatusEl.textContent = `Room notes exported: ${download.filename}`;
    } catch (error) {
      console.warn("room_notes_export_failed", error);
      setNotesSaveState("save_failed", "Room notes export failed", notesErrorCode(error));
    } finally {
      state.notesExportInFlight = false;
      renderNotesHistoryUi();
    }
  }

  return {
    canViewNotes,
    syncNotesAccessUi,
    loadActiveNote,
    scheduleNotesAutosave,
    saveActiveNote,
    restoreSelectedNoteVersion,
    exportActiveNote,
    exportRoomNotesJson
  };
}
