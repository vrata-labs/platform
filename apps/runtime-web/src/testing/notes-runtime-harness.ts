import type { TestContext } from "node:test";
import { createRoomAccessDebugState, type RoomPermission } from "@vrata/shared-types";
import type { RuntimeNoteRecord, RuntimeNoteVersionRecord } from "../index.js";
import { createNotesRuntime, createNotesRuntimeState, type NotesRuntimeContext, type NotesRuntimeElements } from "../notes-runtime.js";

// This deliberately small DOM double records text-only rendering. Real DOM behavior
// is covered separately by the existing browser notes scenarios.
export class NotesElement {
  textContent: string | null = "";
  value = "";
  disabled = false;
  hidden = false;
  selected = false;
  children: NotesElement[] = [];
  constructor(readonly tagName: string) {}
  append(...children: NotesElement[]): void { this.children.push(...children); }
  replaceChildren(...children: NotesElement[]): void {
    this.children = children;
    if (this.tagName === "select") {
      this.value = (children.find((child) => child.selected) ?? children[0])?.value ?? "";
    }
  }
}

export function note(content = "stored", updatedAt: string | null = "2026-09-01T12:00:00Z"): RuntimeNoteRecord {
  return { noteId: "note", roomId: "room", scope: "shared", content, updatedAt };
}

export function version(versionId = "v1", action: RuntimeNoteVersionRecord["action"] = "save"): RuntimeNoteVersionRecord {
  return { ...note(), versionId, action, createdAt: "2026-09-01T12:00:00Z" };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export function notesHarness(t: TestContext) {
  const tags: Record<keyof NotesRuntimeElements, string> = {
    notesPanelEl: "div", notesScopeSelect: "select", notesEditor: "textarea",
    notesRetrySaveButton: "button", notesStatusEl: "div", notesPreviewEl: "div",
    notesVersionSelect: "select", notesRestoreVersionButton: "button",
    notesExportMarkdownButton: "button", notesExportJsonButton: "button", notesExportRoomJsonButton: "button"
  };
  const elements = Object.fromEntries(Object.entries(tags).map(([key, tag]) => [key, new NotesElement(tag)])) as Record<keyof NotesRuntimeElements, NotesElement>;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const timerEvents: Array<[string, number]> = [];
  let nextTimer = 0;
  const confirmations: string[] = [];
  const controls = { confirm: true, flags: { notesEnabled: true }, token: "token-1", flagReads: 0, tokenReads: 0 };
  const globals = {
    document: { createElement: (tag: string) => new NotesElement(tag) },
    Option: class extends NotesElement {
      constructor(text: string, value: string) { super("option"); this.textContent = text; this.value = value; }
    },
    window: {
      setTimeout(callback: () => void, delay: number) {
        const id = ++nextTimer; timers.set(id, { callback, delay }); timerEvents.push(["set", id]); return id;
      },
      clearTimeout(id: number) { timers.delete(id); timerEvents.push(["clear", id]); },
      confirm(message: string) { confirmations.push(message); return controls.confirm; }
    }
  };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
  const calls: Array<{ name: keyof NotesRuntimeContext["api"]; args: unknown[]; receiver: unknown }> = [];
  const handlers: Partial<NotesRuntimeContext["api"]> = {};
  const api: NotesRuntimeContext["api"] = {
    async fetchRoomNote(this: unknown, ...args) {
      calls.push({ name: "fetchRoomNote", args, receiver: this });
      return handlers.fetchRoomNote ? handlers.fetchRoomNote(...args) : note();
    },
    async listRoomNoteVersions(this: unknown, ...args) {
      calls.push({ name: "listRoomNoteVersions", args, receiver: this });
      return handlers.listRoomNoteVersions ? handlers.listRoomNoteVersions(...args) : [];
    },
    async saveRoomNote(this: unknown, ...args) {
      calls.push({ name: "saveRoomNote", args, receiver: this });
      return handlers.saveRoomNote ? handlers.saveRoomNote(...args) : note(args[4]);
    },
    async restoreRoomNoteVersion(this: unknown, ...args) {
      calls.push({ name: "restoreRoomNoteVersion", args, receiver: this });
      return handlers.restoreRoomNoteVersion ? handlers.restoreRoomNoteVersion(...args) : note("restored");
    },
    async exportRoomNote(this: unknown, ...args) {
      calls.push({ name: "exportRoomNote", args, receiver: this });
      return handlers.exportRoomNote ? handlers.exportRoomNote(...args) : { blob: new Blob(["note"]), filename: "note.md" };
    },
    async exportRoomNotesArchive(this: unknown, ...args) {
      calls.push({ name: "exportRoomNotesArchive", args, receiver: this });
      return handlers.exportRoomNotesArchive ? handlers.exportRoomNotesArchive(...args) : { blob: new Blob(["notes"]), filename: "notes.json" };
    }
  };
  const state = createNotesRuntimeState("shared");
  const debugState: NotesRuntimeContext["debugState"] = {
    access: createRoomAccessDebugState("admin"),
    notes: { enabled: true, scope: "shared", saveState: "idle", canEdit: false, contentLength: 0, versionCount: 0, exportInFlight: false, updatedAt: null, errorCode: null }
  };
  const downloads: Array<{ blob: Blob; filename: string }> = [];
  let downloadError: unknown;
  const context: NotesRuntimeContext = {
    state, elements: elements as unknown as NotesRuntimeElements, api,
    apiBaseUrl: "https://example.test", roomId: "room", debugState,
    get runtimeFlags() { controls.flagReads++; return controls.flags; },
    get roomStateAccessToken() { controls.tokenReads++; return controls.token; },
    downloadBlob(blob, filename) {
      if (downloadError) throw downloadError;
      downloads.push({ blob, filename });
    }
  };
  const runtime = createNotesRuntime(context);
  return {
    runtime, state, elements, controls, context, calls, handlers, warnings, downloads, confirmations, timers, timerEvents,
    setPermissions(...permissions: RoomPermission[]) { debugState.access = { ...debugState.access, permissions }; },
    failDownload(error: unknown) { downloadError = error; },
    fireTimer(id = state.notesAutosaveTimer) {
      if (id === null || !timers.has(id)) throw new Error("missing_test_timer");
      const timer = timers.get(id)!; timers.delete(id); timer.callback();
    }
  };
}
