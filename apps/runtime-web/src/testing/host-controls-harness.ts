import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { PresenceState, RuntimeSessionControlResponse } from "../index.js";
import { createHostControlsRuntime, type HostControlsContext } from "../host-controls-runtime.js";

class HostTestElement extends EventTarget {
  hidden = false;
  disabled = false;
  readonly textWrites: string[] = [];
  private text = "";
  get textContent(): string { return this.text; }
  set textContent(value: string) { this.text = value; this.textWrites.push(value); }
}

class HostTestOption extends HostTestElement {
  value = "";
  selected = false;
}

// Only the single-select operations used by host controls are modeled. In
// particular, appending the first option selects it without an explicit value.
export class HostTestSelect extends HostTestElement {
  readonly options: HostTestOption[] = [];
  private selection: HostTestOption | null = null;
  get value(): string { return this.selection?.value ?? ""; }
  set value(value: string) {
    this.select(this.options.find((option) => option.value === value) ?? null);
  }
  private select(option: HostTestOption | null): void {
    this.selection = option;
    for (const item of this.options) item.selected = item === option;
  }
  replaceChildren(...nodes: (Node | string)[]): void {
    assert.equal(nodes.length, 0, "host controls only clear the select");
    this.options.length = 0;
    this.selection = null;
  }
  appendChild<T extends Node>(node: T): T {
    const option = node as unknown as HostTestOption;
    assert.ok(option instanceof HostTestOption, "only options can be appended");
    this.options.push(option);
    if (option.selected || !this.selection) this.select(option);
    return node;
  }
}

export function makeHostParticipant(participantId: string, displayName = participantId): PresenceState {
  return {
    participantId, displayName, mode: "desktop", rootTransform: { x: 0, y: 0, z: 0 },
    muted: true, activeMedia: { audio: false, screenShare: false }, updatedAt: "2026-01-01T00:00:00Z"
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

export function createHostControlsHarness(t: TestContext) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const created: HostTestOption[] = [];
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement(tag: string) {
      assert.equal(tag, "option");
      const option = new HostTestOption(); created.push(option); return option;
    }
  } });
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  });
  const elements = {
    hostControlsEl: new HostTestElement(), hostControlsStatusEl: new HostTestElement(),
    presenterLineEl: new HostTestElement(), hostParticipantSelect: new HostTestSelect(),
    lockRoomButton: new HostTestElement(), unlockRoomButton: new HostTestElement(),
    endSessionButton: new HostTestElement(), removeParticipantButton: new HostTestElement(),
    transferHostButton: new HostTestElement(), grantPresenterButton: new HostTestElement(),
    revokePresenterButton: new HostTestElement()
  };
  const inputs: Pick<HostControlsContext,
    "runtimeFlags" | "roomStateAccessToken" | "latestRealtimeParticipants" | "latestFallbackParticipants" | "debugState"
  > = {
    runtimeFlags: { hostControlsEnabled: true }, roomStateAccessToken: "token-1",
    latestRealtimeParticipants: [], latestFallbackParticipants: [],
    debugState: {
      access: { canManageRoomSession: true },
      hostControls: { enabled: false, visible: false, locked: false, ended: false,
        hostParticipantId: null, presenterParticipantId: null, selectedParticipantId: null,
        status: "idle", lastReason: null }
    }
  };
  // Replacing these objects models main's boot and room-state callbacks, rather
  // than testing only mutation of the objects present at construction time.
  const state = { ...inputs };
  const fetchCalls: Parameters<HostControlsContext["fetchRoomSessionControl"]>[] = [];
  const accessCalls: Parameters<HostControlsContext["applyAccessDebug"]>[] = [];
  const blockCalls: string[] = [];
  const warnings: unknown[][] = [];
  const errors: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args); });
  const hooks: {
    fetch?: HostControlsContext["fetchRoomSessionControl"];
    access?: HostControlsContext["applyAccessDebug"];
    block?: HostControlsContext["disableRuntimeForSessionBlock"];
  } = {};
  const context: HostControlsContext = {
    ...elements, apiBaseUrl: "https://example.invalid", roomId: "room", participantId: "self",
    get debugState() { return state.debugState; },
    get runtimeFlags() { return state.runtimeFlags; },
    get roomStateAccessToken() { return state.roomStateAccessToken; },
    get latestRealtimeParticipants() { return state.latestRealtimeParticipants; },
    get latestFallbackParticipants() { return state.latestFallbackParticipants; },
    async fetchRoomSessionControl(this: unknown, ...args) {
      assert.equal(this, undefined); fetchCalls.push(args);
      const fetch = hooks.fetch;
      return fetch ? fetch(...args) : { state: {} };
    },
    applyAccessDebug(this: unknown, ...args) {
      assert.equal(this, undefined); accessCalls.push(args);
      const access = hooks.access;
      if (access) access(...args);
    },
    disableRuntimeForSessionBlock(this: unknown, reason) {
      assert.equal(this, undefined); blockCalls.push(reason);
      const block = hooks.block;
      if (block) block(reason);
    }
  };
  const runtime = createHostControlsRuntime(context);
  async function respond(payload: RuntimeSessionControlResponse): Promise<void> {
    hooks.fetch = async () => payload;
    await runtime.refreshSessionControl(true);
  }
  return { context, state, elements, created, hooks, fetchCalls, accessCalls, blockCalls,
    warnings, errors, runtime, respond };
}
