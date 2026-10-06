import { expect, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { PDFDocument, rgb } from "pdf-lib";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type DemoRole = "host" | "member" | "guest";
type JsonRecord = Record<string, any>;

type PublicDemoModule = {
  cleanupPublicDemo(options: JsonRecord): Promise<JsonRecord>;
  publicDemoCleanupRecordPath(stateFile: string): string;
  readPublicDemoState(stateFile: string, options?: JsonRecord): Promise<JsonRecord>;
  seedPublicDemo(options: JsonRecord): Promise<JsonRecord>;
};

type DemoClient = {
  context: BrowserContext;
  page: Page;
  role: DemoRole;
  inviteLink: string;
  displayName: string;
  participantId: string;
  sessionToken: string;
  audioMock: boolean;
  requireDevRoleQueryDisabled: boolean;
  pdfCapture?: PdfCommandCapture;
};

export type PublicDemoScenarioOptions = {
  browser: Browser;
  testInfo: TestInfo;
  origin: string;
  adminToken: string;
  staging: boolean;
};

const viewport = { width: 640, height: 400 };
// Match the reference screen-share functional budget: preserve the CSS HUD
// layout while limiting concurrent software-rendered drawing buffers. PDF
// textures, capture source, real transport and audio deadlines are unchanged.
const deviceScaleFactor = 0.5;
const requestTimeoutMs = 15_000;
const corePollIntervals = [250, 500, 1_000, 2_000];
const expectedCatalog = [
  { templateId: "meeting-room-basic", currentVersion: "2.0.0", status: "active" },
  { templateId: "personal-room-basic", currentVersion: "2.0.0", status: "active" },
  { templateId: "presentation-room-basic", currentVersion: "2.0.0", status: "active" }
];

let demoModulePromise: Promise<PublicDemoModule> | undefined;

type PdfOperation = "create" | "select-document" | "go-to-page" | "stop";
type PdfCommandResultEvidence = {
  type: "surface_command_result" | "access_denied";
  accepted: boolean;
  blockedReason: string | null;
  objectId: string | null;
  surfaceId: string | null;
  revision: number | null;
};
type PdfCommandEvidence = {
  commandId: string;
  operation: PdfOperation;
  type: string | null;
  page: number | null;
  expectedRevision: number | null;
  objectId: string | null;
  surfaceId: string | null;
  sentSequence: number | null;
  receivedSequence: number | null;
  result: PdfCommandResultEvidence | null;
};
type PdfActionEvidence = {
  operation: "select-document" | "go-to-page";
  expectedPage: number;
  fromSequence: number;
  toSequence: number | null;
  activation: ReturnType<typeof pdfActionSnapshot> | null;
};
type PdfCommandCapture = Awaited<ReturnType<typeof capturePdfCommands>>;

function classifyPdfRuntimeError(error: JsonRecord = {}, fallback = "") {
  const errorClass = ["Error", "TypeError", "ReferenceError", "RangeError", "SyntaxError", "DOMException", "Event", "ErrorEvent"]
    .includes(error.className) ? error.className : "OtherError";
  // Descriptions are used only for classification, never retained or returned.
  const text = String(error.description ?? fallback).slice(0, 2_000).replace(/^(?:Uncaught(?: \(in promise\))? )?(?:\w*Error: )?/, "");
  const fixed = ["invalid_avatar_pose_preview_participant", "invalid_seat_claim_result", "invalid_access_result", "missing_runtime_media_surface"]
    .find(code => text === code || text.startsWith(`${code}\n`));
  const category = fixed ?? (/^Cannot read properties of undefined/.test(text) ? "cannot-read-undefined"
    : /^Cannot read properties of null/.test(text) ? "cannot-read-null"
    : /^Cannot set properties of (?:undefined|null)/.test(text) ? "cannot-set-nullish"
    : /^Cannot access .+ before initialization/.test(text) ? "before-initialization"
    : /is not a function(?:\n|$)/.test(text) ? "not-a-function"
    : /is not iterable(?:\n|$)/.test(text) ? "not-iterable"
    : /is not defined(?:\n|$)/.test(text) ? "not-defined"
    : errorClass === "SyntaxError" ? "syntax-error"
    : ["Event", "ErrorEvent"].includes(errorClass) ? "native-event" : "other");
  return { errorClass, category };
}

function observeNativeRoomStateSockets() {
  const root = window as any;
  const NativeWebSocket = window.WebSocket;
  const listeners: Array<() => void> = [];
  let socketCount = 0;
  const WrappedWebSocket = new Proxy(NativeWebSocket, {
    construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget) as WebSocket;
      let roomState = false;
      try {
        const url = new URL(socket.url);
        roomState = url.searchParams.has("roomId") && url.searchParams.has("participantId");
      } catch { /* No URL or exception data enters the observation. */ }
      if (!roomState || socketCount >= 32) return socket;
      const scope = ++socketCount;
      const emit = (event: JsonRecord) => {
        try { root.__publicDemoRoomStateObservation(JSON.stringify({ ...event, socket: scope })); } catch { /* Diagnostics never affect socket delivery. */ }
      };
      const onOpen = () => emit({ type: "native-open" });
      const onError = () => emit({ type: "native-error" });
      const onClose = (event: CloseEvent) => emit({ type: "native-close", code: event.code, wasClean: event.wasClean,
        reason: ["identity_upgrade_required", "identity_recovery_required"].includes(event.reason) ? event.reason : event.reason ? "other" : "empty" });
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
      listeners.push(() => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
      });
      return socket;
    }
  });
  window.WebSocket = WrappedWebSocket;
  root.__publicDemoRoomStateObservationCleanup = () => {
    for (const remove of listeners) remove();
    if (window.WebSocket === WrappedWebSocket) window.WebSocket = NativeWebSocket;
    delete root.__publicDemoRoomStateObservation;
    delete root.__publicDemoRoomStateObservationCleanup;
  };
}

async function capturePdfCommands(page: Page) {
  const session = await page.context().newCDPSession(page);
  const commands: PdfCommandEvidence[] = [];
  const actions: PdfActionEvidence[] = [];
  let sequence = 0;
  let droppedCommands = 0;
  let closed = false;
  const startedAt = performance.now();
  const observations: JsonRecord[] = [];
  let droppedObservations = 0;
  const sockets = new Map<string, number>();
  let socketCount = 0;
  let initScriptId: string | undefined;
  const observe = (facts: JsonRecord) => {
    observations.push({ sequence: ++sequence, atMs: Math.round(performance.now() - startedAt), ...facts });
    // Preserve early evidence as well as the latest events if errors repeat.
    if (observations.length > 32) { observations.splice(8, 1); droppedObservations++; }
  };
  const onSocketCreated = (event: { requestId: string; url: string }) => {
    try {
      const url = new URL(event.url);
      if (!url.searchParams.has("roomId") || !url.searchParams.has("participantId")) return;
      sockets.set(event.requestId, ++socketCount);
      observe({ type: "cdp-websocket-created", socket: socketCount });
      if (sockets.size > 32) sockets.delete(sockets.keys().next().value!);
    } catch { /* Keep only opaque CDP request scope, never a URL. */ }
  };
  const onSocketClosed = (event: { requestId: string }) => {
    const socket = sockets.get(event.requestId);
    if (socket) observe({ type: "cdp-websocket-closed", socket });
  };
  const onFrameError = (event: { requestId: string }) => {
    const socket = sockets.get(event.requestId);
    if (socket) observe({ type: "cdp-websocket-frame-error", socket });
  };
  const onException = (event: { exceptionDetails: JsonRecord }) => {
    observe({ type: "runtime-exception", ...classifyPdfRuntimeError(event.exceptionDetails.exception, event.exceptionDetails.text) });
  };
  const onConsole = (event: { type: string; args: JsonRecord[] }) => {
    if (event.type !== "error") return;
    const error = event.args.find(arg => arg.subtype === "error" || ["Event", "ErrorEvent"].includes(arg.className));
    if (error) observe({ type: "console-error", ...classifyPdfRuntimeError(error) });
  };
  const onBinding = (event: { name: string; payload: string }) => {
    if (event.name !== "__publicDemoRoomStateObservation" || event.payload.length > 512) return;
    let facts: JsonRecord;
    try { facts = JSON.parse(event.payload); } catch { return; }
    if (!facts || !["native-open", "native-error", "native-close"].includes(facts.type)
      || !Number.isInteger(facts.socket) || facts.socket < 1 || facts.socket > 32) return;
    observe({ type: facts.type, socket: facts.socket,
      ...(facts.type === "native-close" ? {
        code: Number.isInteger(facts.code) && facts.code >= 0 && facts.code <= 4999 ? facts.code : null,
        wasClean: typeof facts.wasClean === "boolean" ? facts.wasClean : null,
        reason: ["identity_upgrade_required", "identity_recovery_required", "other", "empty"].includes(facts.reason) ? facts.reason : "other"
      } : {}) });
  };
  const removeExtraObservers = async () => {
    session.off("Network.webSocketCreated", onSocketCreated);
    session.off("Network.webSocketClosed", onSocketClosed);
    session.off("Network.webSocketFrameError", onFrameError);
    session.off("Runtime.exceptionThrown", onException);
    session.off("Runtime.consoleAPICalled", onConsole);
    session.off("Runtime.bindingCalled", onBinding);
    await session.send("Runtime.evaluate", { expression: "globalThis.__publicDemoRoomStateObservationCleanup?.()" }).catch(() => undefined);
    if (initScriptId) await session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: initScriptId }).catch(() => undefined);
    await session.send("Runtime.removeBinding", { name: "__publicDemoRoomStateObservation" }).catch(() => undefined);
  };
  const id = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value) ? value : null;
  const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
  const onFrame = (direction: "sent" | "received", event: { response: { opcode: number; payloadData: string } }) => {
    // Read only text frames carrying a platform-generated PDF command ID. Never
    // retain frame bodies, socket URLs, headers, document contents, or credentials.
    const frame = event.response;
    if (frame.opcode !== 1 || frame.payloadData.length > 32_768 || !frame.payloadData.includes(":pdf-presentation-")) return;
    let payload: JsonRecord;
    try { payload = JSON.parse(frame.payloadData); } catch { return; }
    if (!payload || typeof payload !== "object") return;
    const source = direction === "sent" ? payload : payload.result;
    const match = typeof source?.commandId === "string"
      ? source.commandId.match(/^[A-Za-z0-9._-]{1,128}:pdf-presentation-(create|select-document|go-to-page|stop):[0-9]{1,16}:[a-f0-9]{1,32}$/)
      : null;
    if (!match) return;
    const operation = match[1] as PdfOperation;
    if (direction === "sent") {
      const expectedType = operation === "create" ? "surface_create_object" : operation === "stop" ? "surface_stop_object" : "surface_patch_object_state";
      if (payload.type !== expectedType
        || (operation === "create" && payload.objectType !== "pdf-presentation")
        || (["select-document", "go-to-page"].includes(operation) && payload.patch?.type !== operation)) return;
    } else if (!["surface_command_result", "access_denied"].includes(payload.type) || typeof source.accepted !== "boolean") return;
    let command = commands.find(item => item.commandId === source.commandId);
    if (!command) {
      command = { commandId: source.commandId, operation, type: null, page: null, expectedRevision: null,
        objectId: null, surfaceId: null, sentSequence: null, receivedSequence: null, result: null };
      commands.push(command);
      if (commands.length > 64) { commands.shift(); droppedCommands++; }
    }
    if (direction === "sent") {
      command.type = payload.type;
      command.page = operation === "go-to-page" ? integer(payload.patch.page) : null;
      command.expectedRevision = integer(payload.expectedRevision);
      command.objectId = id(payload.objectId);
      command.surfaceId = id(payload.surfaceId);
      command.sentSequence = ++sequence;
    } else {
      command.receivedSequence = ++sequence;
      command.result = { type: payload.type, accepted: source.accepted,
        blockedReason: typeof source.blockedReason === "string" ? (/^[a-z][a-z0-9-]{0,80}$/.test(source.blockedReason) ? source.blockedReason : "other") : null,
        objectId: id(source.objectId), surfaceId: id(source.surfaceId), revision: integer(source.revision) };
    }
  };
  const onSent = (event: Parameters<typeof onFrame>[1]) => onFrame("sent", event);
  const onReceived = (event: Parameters<typeof onFrame>[1]) => onFrame("received", event);
  const onClosed = () => { closed = true; };
  session.on("Network.webSocketFrameSent", onSent);
  session.on("Network.webSocketFrameReceived", onReceived);
  session.on("Inspector.detached", onClosed);
  session.on("Network.webSocketCreated", onSocketCreated);
  session.on("Network.webSocketClosed", onSocketClosed);
  session.on("Network.webSocketFrameError", onFrameError);
  session.on("Runtime.exceptionThrown", onException);
  session.on("Runtime.consoleAPICalled", onConsole);
  session.on("Runtime.bindingCalled", onBinding);
  page.on("close", onClosed);
  try {
    await session.send("Network.enable");
    await session.send("Runtime.enable");
    await session.send("Page.enable");
    await session.send("Runtime.addBinding", { name: "__publicDemoRoomStateObservation" });
    initScriptId = (await session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(${observeNativeRoomStateSockets.toString()})()`
    })).identifier;
  } catch {
    await removeExtraObservers();
    session.off("Network.webSocketFrameSent", onSent);
    session.off("Network.webSocketFrameReceived", onReceived);
    session.off("Inspector.detached", onClosed);
    page.off("close", onClosed);
    await session.detach().catch(() => undefined);
    throw new Error("public_demo_pdf_capture_setup_failed");
  }
  return {
    beginAction(operation: PdfActionEvidence["operation"], expectedPage: number) {
      const previous = actions.at(-1);
      if (previous) previous.toSequence = sequence;
      const action: PdfActionEvidence = { operation, expectedPage, fromSequence: sequence, toSequence: null, activation: null };
      actions.push(action);
      if (actions.length > 8) actions.shift();
      return action;
    },
    snapshot() {
      return { captureClosed: closed, droppedCommands, droppedObservations, observations, commands, actions: actions.map(action => {
        const correlated = commands.filter(command => command.sentSequence !== null
          && command.sentSequence > action.fromSequence && command.sentSequence <= (action.toSequence ?? sequence));
        const matching = correlated.filter(command => command.operation === action.operation
          && (action.operation !== "go-to-page" || command.page === action.expectedPage)
          && command.commandId !== action.activation?.before.lastCommand?.commandId);
        return { ...action, observedCommandIds: correlated.map(command => command.commandId),
          matchingActionCommandIds: matching.map(command => command.commandId) };
      }) };
    },
    async close() {
      closed = true;
      await removeExtraObservers();
      session.off("Network.webSocketFrameSent", onSent);
      session.off("Network.webSocketFrameReceived", onReceived);
      session.off("Inspector.detached", onClosed);
      page.off("close", onClosed);
      await session.detach().catch(() => undefined);
    }
  };
}

// This function is serialized into the page. The pre/post snapshots and the
// single click share one browser task; status text is classified, never copied.
function pdfActionSnapshot(input: { selector: string; documentId: string | null; activate: boolean }) {
  const button = document.querySelector<HTMLButtonElement>(input.selector);
  const id = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value) ? value : null;
  const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
  const code = (value: unknown) => {
    if (value === null || value === undefined) return null;
    const prefix = typeof value === "string" ? value.split(":")[0]! : "";
    return /^(?:document_|presentation_|surface_command_|room_state_|failed_to_|pdf_|encrypted_pdf_|corrupt_pdf)[a-z_-]{0,80}$/.test(prefix) ? prefix : "other";
  };
  const status = (selector: string) => {
    const text = document.querySelector(selector)?.textContent ?? "";
    return ["Document surface selection failed", "Presentation control failed", "Presentation failed", "Selecting document for surface",
      "Document selected for surface", "Document uploaded", "Documents ready", "Documents unavailable", "Presentable document and presenter role required",
      "Loading presentation PDF", "Presenting", "Presentation idle"].find(prefix => text.startsWith(prefix)) ?? "other";
  };
  const read = () => {
    const debug = (window as any).__VRATA_DEBUG__;
    const presentation = debug?.pdfPresentation;
    const surfaces = debug?.mediaObjects?.surfaces ?? [];
    const selectedSurface = surfaces.find((item: any) => item.surfaceId === debug?.mediaObjects?.selectedSurfaceId);
    const mainSurface = surfaces.find((item: any) => item.surfaceId === "debug-main");
    const pdf = (debug?.mediaObjects?.objects ?? []).find((item: any) => item.type === "pdf-presentation"
      && item.objectId === selectedSurface?.activeObjectId)
      ?? (debug?.mediaObjects?.objects ?? []).find((item: any) => item.type === "pdf-presentation" && item.objectId === presentation?.objectId);
    const last = debug?.mediaObjects?.lastCommand;
    const commandId = typeof last?.commandId === "string"
      && /^[A-Za-z0-9._-]{1,128}:pdf-presentation-(create|select-document|go-to-page|stop):[0-9]{1,16}:[a-f0-9]{1,32}$/.test(last.commandId) ? last.commandId : null;
    return {
      connected: debug?.roomStateConnected === true,
      nativeSocketObservationInstalled: typeof (window as any).__publicDemoRoomStateObservationCleanup === "function",
      roomStateMode: ["disconnected", "colyseus", "api_fallback"].includes(debug?.roomStateMode) ? debug.roomStateMode : null,
      roomStateIssue: ["room_state_failed", "room_access_denied"].includes(debug?.issueCode) ? debug.issueCode : null,
      retryCount: integer(debug?.retryCount),
      roomStateRecovery: ["none", "fallback_api", "retry_room_state", "room_state_retry_exhausted", "presence_sync_failed", "presence_refresh_failed"]
        .includes(debug?.lastRecoveryAction) ? debug.lastRecoveryAction : null,
      sessionUpgradeVisible: document.querySelector<HTMLDialogElement>("#session-upgrade-dialog")?.open ?? null,
      hasDocumentViewPermission: debug?.access?.permissions?.includes("document.view") === true,
      hasDocumentPresentPermission: debug?.access?.permissions?.includes("document.present") === true,
      documentsEnabled: debug?.featureFlags?.documentsEnabled === true,
      accessRole: ["host", "member", "guest"].includes(debug?.access?.role) ? debug.access.role : null,
      accessDenied: debug?.issueCode === "room_access_denied",
      visibility: document.visibilityState, focused: document.hasFocus(),
      buttonExists: Boolean(button), buttonDisabled: button?.disabled ?? null,
      buttonEffectivelyDisabled: button?.matches(":disabled") ?? null,
      presentationControlsHidden: document.querySelector("#presentation-controls")?.hasAttribute("hidden") ?? null,
      selectedSurfaceId: id(debug?.mediaObjects?.selectedSurfaceId),
      documentsCount: integer(debug?.documents?.count),
      documentsPanelHidden: document.querySelector("#documents-panel")?.hasAttribute("hidden") ?? null,
      documentSelectDisabled: document.querySelector<HTMLSelectElement>("#document-select")?.disabled ?? null,
      documentUploadDisabled: document.querySelector<HTMLButtonElement>("#document-upload-button")?.disabled ?? null,
      selectedDocumentMatches: input.documentId === null ? null : debug?.documents?.selectedDocumentId === input.documentId,
      selectedDocumentControlMatches: input.documentId === null ? null : document.querySelector<HTMLSelectElement>("#document-select")?.value === input.documentId,
      documentStatus: status("#document-status"), documentError: code(debug?.documents?.errorCode),
      presentationStatus: status("#presentation-status"), presentationError: code(presentation?.errorCode),
      currentPdf: pdf ? { objectId: id(pdf.objectId), surfaceId: id(pdf.surfaceId), revision: integer(pdf.revision),
        active: pdf.state?.status === "active", page: integer(pdf.state?.currentPage), pageCount: integer(pdf.state?.pageCount),
        documentMatches: input.documentId === null ? null : pdf.state?.documentId === input.documentId } : null,
      presentation: { objectId: id(presentation?.objectId), surfaceId: id(presentation?.surfaceId),
        documentMatches: input.documentId === null ? null : presentation?.documentId === input.documentId,
        page: integer(presentation?.page), pageCount: integer(presentation?.pageCount),
        loadState: ["idle", "loading", "ready", "failed"].includes(presentation?.loadState) ? presentation.loadState : null,
        renderState: ["idle", "rendering", "ready", "failed"].includes(presentation?.renderState) ? presentation.renderState : null,
        hasRenderTiming: typeof presentation?.lastRenderMs === "number", hasTexture: typeof mainSurface?.textureId === "number" },
      lastCommand: commandId ? { commandId, accepted: typeof last.accepted === "boolean" ? last.accepted : null,
        blockedReason: typeof last.blockedReason === "string" ? (/^[a-z][a-z0-9-]{0,80}$/.test(last.blockedReason) ? last.blockedReason : "other") : null,
        objectId: id(last.objectId), surfaceId: id(last.surfaceId), revision: integer(last.revision) } : null
    };
  };
  const before = read();
  if (!input.activate || !button || button.disabled) return { before, postDispatch: null, didClick: false, clickEventObserved: false };
  let clickEventObserved = false;
  const onClick = () => { clickEventObserved = true; };
  button.addEventListener("click", onClick, { once: true });
  try { button.click(); } finally { button.removeEventListener("click", onClick); }
  return { before, postDispatch: read(), didClick: true, clickEventObserved };
}

function loadPublicDemoModule(): Promise<PublicDemoModule> {
  demoModulePromise ??= import(pathToFileURL(resolve("tools/public-demo.mjs")).href) as Promise<PublicDemoModule>;
  return demoModulePromise;
}

async function pathExists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
}

async function responseJson(response: Response, step: string): Promise<JsonRecord> {
  try {
    return await response.json() as JsonRecord;
  } catch {
    throw new Error(`${step}_invalid_json`);
  }
}

async function fetchJson(
  origin: string,
  path: string,
  init: RequestInit,
  step: string
): Promise<{ status: number; data: JsonRecord }> {
  let response: Response;
  try {
    response = await fetch(new URL(path, origin), {
      ...init,
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
  } catch {
    throw new Error(`${step}_request_failed`);
  }
  return { status: response.status, data: await responseJson(response, step) };
}

async function adminJson(
  origin: string,
  adminToken: string,
  path: string,
  init: RequestInit,
  step: string
): Promise<{ status: number; data: JsonRecord }> {
  const headers = new Headers(init.headers);
  headers.set("x-vrata-admin-token", adminToken);
  if (init.body) headers.set("content-type", "application/json");
  return fetchJson(origin, path, { ...init, headers }, step);
}

function requireStatus(actual: number, expected: number, step: string): void {
  if (actual !== expected) throw new Error(`${step}_unexpected_status_${actual}`);
}

function inviteToken(inviteLink: string): string {
  let url: URL;
  try {
    url = new URL(inviteLink);
  } catch {
    throw new Error("public_demo_invite_invalid");
  }
  const token = url.searchParams.get("invite");
  const keys = [...url.searchParams.keys()];
  if (!token || keys.length !== 1 || keys[0] !== "invite") throw new Error("public_demo_invite_invalid");
  return token;
}

function decodeSessionToken(token: string): JsonRecord {
  const body = token.split(".")[0];
  if (!body) throw new Error("public_demo_session_token_invalid");
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as JsonRecord;
  } catch {
    throw new Error("public_demo_session_token_invalid");
  }
}

async function requestStateToken(
  origin: string,
  roomId: string,
  input: { inviteToken?: string; requestedRole?: string },
  step: string
): Promise<{ status: number; data: JsonRecord }> {
  return fetchJson(origin, "/api/tokens/state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      roomId,
      participantId: `public-demo-check-${randomUUID()}`,
      displayName: "Public demo access check",
      ...input
    })
  }, step);
}

async function expectStateTokenDenied(
  origin: string,
  roomId: string,
  input: { inviteToken?: string; requestedRole?: string },
  reason: string,
  step: string
): Promise<void> {
  const result = await requestStateToken(origin, roomId, input, step);
  requireStatus(result.status, 403, step);
  if (result.data.error !== "room_access_denied" || result.data.reason !== reason) {
    throw new Error(`${step}_wrong_denial`);
  }
}

function browserInviteUrl(inviteLink: string, input: { audioMock?: boolean } = {}): string {
  const url = new URL(inviteLink);
  inviteToken(inviteLink);
  if (input.audioMock) {
    url.searchParams.set("debug", "1");
    url.searchParams.set("scenefit", "0");
    url.searchParams.set("audiomock", "1");
  }
  return url.href;
}

async function navigateAndRemoveSensitiveQuery(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  } catch {
    throw new Error("public_demo_browser_navigation_failed");
  }
  await page.addStyleTag({ content: "#debug-panel,#xr-debug-panel { display: none !important; }" });
  if (new URL(url).searchParams.has("invite")) {
    await expect(page.locator("#guest-onboarding")).toBeVisible({ timeout: 30_000 });
  }
  try {
    await page.evaluate(() => {
      history.replaceState(null, "", location.pathname);
    });
  } catch {
    throw new Error("public_demo_browser_url_redaction_failed");
  }
}

async function waitForOnboarding(page: Page): Promise<void> {
  await expect(page.locator("#guest-onboarding")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#guest-enter-without-audio")).toBeEnabled();
  await expect.poll(() => page.locator("#guest-enter-without-audio").evaluate((button) =>
    typeof (button as HTMLButtonElement).onclick === "function"), {
    timeout: 30_000,
    intervals: corePollIntervals
  }).toBe(true);
}

async function tokenResponseForNextJoin(page: Page): Promise<import("@playwright/test").Response> {
  return page.waitForResponse((response) => {
    const request = response.request();
    return request.method() === "POST" && new URL(response.url()).pathname === "/api/tokens/state";
  }, { timeout: 45_000 });
}

async function completeOnboarding(page: Page, displayName: string): Promise<import("@playwright/test").Response> {
  await waitForOnboarding(page);
  const responsePromise = tokenResponseForNextJoin(page);
  void responsePromise.catch(() => undefined);
  await page.locator("#guest-name-input").fill(displayName);
  await page.locator("#guest-enter-without-audio").evaluate((button: HTMLButtonElement) => button.click());
  const onboarding = await page.evaluate(() => ({
    completed: (window as any).__VRATA_DEBUG__?.guestOnboarding?.completed ?? false,
    handler: typeof (document.querySelector("#guest-enter-without-audio") as HTMLButtonElement | null)?.onclick,
    status: document.querySelector("#guest-onboarding-status")?.textContent ?? null
  }));
  if (!onboarding.completed) throw new Error(`public_demo_onboarding_not_completed:${JSON.stringify(onboarding)}`);
  try {
    return await responsePromise;
  } catch {
    const state = await page.evaluate(() => ({
      status: document.querySelector("#status-line")?.textContent ?? null,
      onboarding: document.querySelector("#guest-onboarding")?.hasAttribute("hidden") ?? null,
      issue: (window as any).__VRATA_DEBUG__?.issueCode ?? null
    })).catch(() => null);
    throw new Error(`public_demo_onboarding_token_request_missing:${JSON.stringify(state)}`);
  }
}

async function expectInviteBrowserDenied(page: Page, link: string, displayName: string, message: string): Promise<void> {
  await navigateAndRemoveSensitiveQuery(page, browserInviteUrl(link));
  const response = await completeOnboarding(page, displayName);
  requireStatus(response.status(), 403, "public_demo_denied_invite_browser");
  await expect(page.locator("#status-line")).toContainText(message, { timeout: 30_000 });
}

async function expectDirectRoomBrowserDenied(page: Page, origin: string, roomId: string): Promise<void> {
  await navigateAndRemoveSensitiveQuery(page, new URL(`/rooms/${roomId}?debug=1&scenefit=0`, origin).href);
  await expect(page.locator("#status-line")).toContainText("Access denied: private invite required", { timeout: 30_000 });
}

function assertTrustedSession(data: JsonRecord, expectedRole: DemoRole): { participantId: string; token: string } {
  const token = typeof data.token === "string" ? data.token : "";
  const payload = decodeSessionToken(token);
  if (data.role !== expectedRole
    || payload.role !== expectedRole
    || payload.roleSource !== "trusted"
    || typeof payload.participantId !== "string"
    || !payload.participantId) {
    throw new Error("public_demo_untrusted_session_role");
  }
  return { participantId: payload.participantId, token };
}

async function joinClientPage(input: {
  context: BrowserContext;
  page: Page;
  role: DemoRole;
  inviteLink: string;
  displayName: string;
  audioMock: boolean;
  requireDevRoleQueryDisabled: boolean;
  pdfCaptures?: Map<Page, PdfCommandCapture>;
}, navigate = true): Promise<DemoClient> {
  let pdfCapture = input.pdfCaptures?.get(input.page);
  if (input.pdfCaptures && !pdfCapture) {
    pdfCapture = await capturePdfCommands(input.page);
    input.pdfCaptures.set(input.page, pdfCapture);
  }
  if (navigate) {
    await navigateAndRemoveSensitiveQuery(input.page, browserInviteUrl(input.inviteLink, {
      audioMock: input.audioMock
    }));
  }
  const response = await completeOnboarding(input.page, input.displayName);
  requireStatus(response.status(), 200, "public_demo_browser_join");
  let data: JsonRecord;
  try {
    data = await response.json() as JsonRecord;
  } catch {
    throw new Error("public_demo_browser_join_invalid_json");
  }
  const session = assertTrustedSession(data, input.role);
  await expect.poll(async () => input.page.evaluate(() => {
    const debug = (window as any).__VRATA_DEBUG__;
    return {
      connected: debug?.roomStateConnected ?? false,
      role: debug?.access?.role ?? null
    };
  }), { timeout: 45_000, intervals: corePollIntervals }).toEqual({
    connected: true,
    role: input.role
  });
  if (input.requireDevRoleQueryDisabled) {
    await expect.poll(() => input.page.evaluate(() => (window as any).__VRATA_DEBUG__?.access?.roleQueryAllowed ?? true), {
      timeout: 15_000, intervals: corePollIntervals
    }).toBe(false);
  }
  const debugParticipantId = await input.page.evaluate(() => (window as any).__VRATA_DEBUG__?.participantId ?? "");
  if (debugParticipantId !== session.participantId) throw new Error("public_demo_participant_binding_mismatch");
  expect(await input.page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("#scene canvas");
    return [innerWidth, innerHeight, devicePixelRatio, canvas?.width, canvas?.height];
  })).toEqual([640, 400, 0.5, 320, 200]);
  expect(await input.page.title()).toBe("Vrata Room");
  if (new URL(input.page.url()).searchParams.has("invite")) throw new Error("public_demo_browser_invite_not_redacted");
  return {
    context: input.context,
    page: input.page,
    role: input.role,
    inviteLink: input.inviteLink,
    displayName: input.displayName,
    participantId: session.participantId,
    sessionToken: session.token,
    audioMock: input.audioMock,
    requireDevRoleQueryDisabled: input.requireDevRoleQueryDisabled,
    pdfCapture
  };
}

async function reloadClientThroughInvite(client: DemoClient): Promise<void> {
  const previousParticipantId = client.participantId;
  const rejoined = await joinClientPage(client);
  if (rejoined.participantId !== previousParticipantId) throw new Error("public_demo_reload_changed_participant");
  client.page = rejoined.page;
  client.sessionToken = rejoined.sessionToken;
}

async function createTrackedContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport, deviceScaleFactor });
  context.setDefaultTimeout(120_000);
  return context;
}

async function waitForExactPresence(clients: DemoClient[]): Promise<void> {
  const expectedIds = clients.map((client) => client.participantId);
  const snapshots = async () => Promise.all(clients.map(async (client) => client.page.evaluate((allParticipantIds) => {
       const debug = (window as any).__VRATA_DEBUG__;
       const localId = debug?.participantId;
       const expectedRemoteIds = allParticipantIds.filter((id) => id !== localId);
       const actualRemoteIds = (debug?.remoteParticipants ?? []).map((participant: any) => participant.participantId);
       return {
         expected: expectedRemoteIds.length,
         avatarCount: debug?.remoteAvatarCount ?? null,
         remoteCount: actualRemoteIds.length,
         matches: expectedRemoteIds.every((id) => actualRemoteIds.includes(id)),
         connected: debug?.roomStateConnected ?? false,
         scene: debug?.sceneBundleState ?? null
       };
    }, expectedIds)));
  try {
    await expect.poll(async () => (await snapshots()).every((state) =>
      state.avatarCount === state.expected && state.remoteCount === state.expected && state.matches),
    { timeout: 120_000, intervals: [1_000, 2_000, 3_000] }).toBe(true);
  } catch {
    const final = await snapshots();
    if (final.every((state) => state.avatarCount === state.expected && state.remoteCount === state.expected && state.matches)) return;
    throw new Error(`public_demo_presence_mismatch:${JSON.stringify(final)}`);
  }
}

async function uploadHostDocument(host: DemoClient, roomId: string, testInfo: TestInfo): Promise<string> {
  const page = host.page;
  const path = `/api/rooms/${roomId}/documents`;
  const upload = async (file: { name: string; mimeType: string; buffer: Buffer }) => {
    await page.setInputFiles("#document-upload-input", file);
    const response = page.waitForResponse(response =>
      response.request().method() === "POST" && new URL(response.url()).pathname === path);
    void response.catch(() => undefined);
    await page.locator("#document-upload-button").click();
    return response;
  };
  await expect(page.locator("#document-upload-button")).toBeEnabled({ timeout: 30_000 });
  const unsupported = await upload({ name: "unsupported.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("unsupported office document") });
  requireStatus(unsupported.status(), 400, "public_demo_host_unsupported_upload");
  expect((await unsupported.json()).error).toBe("unsupported_document_mime");
  await expect(page.locator("#document-status")).toContainText("Unsupported file format");
  // Ordinary session-control polling used to erase both the message and code.
  await page.waitForResponse(response => new URL(response.url()).pathname === `/api/rooms/${roomId}/session-control`);
  // The next poll cannot start until the previous response was applied by UI.
  await page.waitForRequest(request => new URL(request.url()).pathname === `/api/rooms/${roomId}/session-control`);
  await expect(page.locator("#document-status")).toContainText("Unsupported file format");
  expect(await page.evaluate(() => (window as any).__VRATA_DEBUG__?.documents?.errorCode)).toBe("unsupported_document_mime");

  const pdf = await PDFDocument.create();
  for (const [index, color] of [rgb(.85, .12, .12), rgb(.12, .65, .2), rgb(.12, .2, .85)].entries()) {
    const slide = pdf.addPage([640, 360]);
    slide.drawRectangle({ x: 0, y: 0, width: 640, height: 360, color });
    slide.drawText(`Host's own document: page ${index + 1}`, { x: 40, y: 180, size: 24, color: rgb(1, 1, 1) });
  }
  const bytes = Buffer.from(await pdf.save());
  const response = await upload({ name: "host-working-meeting.pdf", mimeType: "application/pdf", buffer: bytes });
  requireStatus(response.status(), 201, "public_demo_host_own_upload");
  const { document } = await response.json();
  expect(document).toMatchObject({
    filename: "host-working-meeting.pdf", contentType: "application/pdf", sizeBytes: bytes.length,
    uploadedBy: host.participantId, metadata: { kind: "pdf", pageCount: 3 },
    checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`
  });
  await expect(page.locator("#document-select")).toHaveValue(document.documentId);
  await expect(page.locator("#document-status")).toContainText("Document uploaded: host-working-meeting.pdf");
  const origin = new URL(host.inviteLink).origin;
  const download = await fetch(new URL(`${path}/${document.documentId}/download`, origin), {
    headers: { authorization: `Bearer ${host.sessionToken}` }, signal: AbortSignal.timeout(requestTimeoutMs)
  });
  requireStatus(download.status, 200, "public_demo_host_own_download");
  expect(Buffer.from(await download.arrayBuffer()).equals(bytes)).toBe(true);
  await testInfo.attach("host-own-document-upload", {
    body: JSON.stringify({ role: host.role, provenance: "trusted-invite", contentType: document.contentType,
      sizeBytes: document.sizeBytes, uploadStatus: response.status(), downloadStatus: download.status,
      downloadMatchesUpload: true, pageCount: 3, unsupportedFormatStatus: unsupported.status(),
      unsupportedFormatError: "unsupported_document_mime", surfaceId: "debug-main" }),
    contentType: "application/json"
  });
  return document.documentId;
}

async function waitForPresentation(clients: DemoClient[], pageNumber: number, documentId: string): Promise<void> {
  for (const client of clients) {
    await client.page.bringToFront();
    const snapshot = async () => client.page.evaluate(({ expectedPage, documentId }) => {
      const debug = (window as any).__VRATA_DEBUG__;
      const presentation = debug?.pdfPresentation;
      const surface = debug?.mediaObjects?.surfaces?.find((item: any) => item.surfaceId === "debug-main");
      const ready = Boolean(presentation?.renderState === "ready"
        && presentation?.page === expectedPage
        && presentation?.documentId === documentId
        && presentation?.pageCount === 3
        && typeof presentation?.lastRenderMs === "number"
        && presentation?.errorCode === null
        && typeof surface?.textureId === "number");
      const texture = (window as any).__VRATA_TEST__?.sampleMediaSurfaceTexture(
        "debug-main",
        { u: 0.5, v: 0.5 },
        { width: 0.8, height: 0.8 }
      );
      return { ready, page: presentation?.page ?? null, renderState: presentation?.renderState ?? null,
        issue: presentation?.errorCode ?? null, scene: debug?.sceneBundleState ?? null,
        visible: texture?.samples?.length === 128 && texture.samples.some((pixel: number[]) => Math.max(...pixel) > 16) };
    }, { expectedPage: pageNumber, documentId });
    try {
      await expect.poll(async () => {
        const current = await snapshot();
        return current.ready && current.visible;
      }, { timeout: 120_000, intervals: [500, 1_000, 2_000] }).toBe(true);
    } catch {
      const state = await snapshot();
      const preconditions = await client.page.evaluate(pdfActionSnapshot, {
        selector: "#presentation-next", documentId, activate: false
      }).then(value => value.before).catch(() => null);
      throw new Error(`public_demo_pdf_page_${pageNumber}_${client.role}_not_rendered:${JSON.stringify({
        ...state, preconditions, commandEvidence: client.pdfCapture?.snapshot() ?? null
      })}`);
    }
  }
}

async function activateButton(page: Page, selector: string, diagnostic?: {
  capture: PdfCommandCapture;
  documentId: string;
  operation: PdfActionEvidence["operation"];
  expectedPage: number;
}): Promise<void> {
  // Poll actionability and dispatch in one page task. A room-state refresh can
  // disable/rebuild host controls between toBeEnabled() and a separate click(),
  // in which case HTMLElement.click() silently does nothing.
  const action = diagnostic?.capture.beginAction(diagnostic.operation, diagnostic.expectedPage);
  await expect.poll(async () => {
    if (diagnostic && action) {
      action.activation = await page.evaluate(pdfActionSnapshot, { selector, documentId: diagnostic.documentId, activate: true });
      return action.activation.didClick;
    }
    return page.locator(selector).evaluate((button: HTMLButtonElement) => {
      if (button.disabled) return false;
      button.click();
      return true;
    });
  }, { timeout: 30_000 }).toBe(true);
}

async function sessionRequest(
  origin: string,
  roomId: string,
  sessionToken: string,
  path: string,
  init: RequestInit,
  step: string
): Promise<{ status: number; data: JsonRecord }> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${sessionToken}`);
  if (init.body) headers.set("content-type", "application/json");
  return fetchJson(origin, `/api/rooms/${roomId}${path}`, { ...init, headers }, step);
}

async function leaveClient(client: DemoClient, origin: string, roomId: string): Promise<void> {
  await client.page.close();
  const departure = await sessionRequest(
    origin,
    roomId,
    client.sessionToken,
    `/presence/${encodeURIComponent(client.participantId)}`,
    { method: "DELETE" },
    "public_demo_presence_departure"
  );
  requireStatus(departure.status, 200, "public_demo_presence_departure");
}

async function denyGuestPresentationControl(guest: DemoClient, roomId: string, documentId: string): Promise<void> {
  await expect(guest.page.locator("#documents-panel")).toBeHidden();
  await expect(guest.page.locator("#presentation-next")).toBeDisabled();
  const denied = await sessionRequest(new URL(guest.inviteLink).origin, roomId, guest.sessionToken, "/documents", { method: "POST" }, "public_demo_guest_document_upload");
  requireStatus(denied.status, 403, "public_demo_guest_document_upload");
  await waitForPresentation([guest], 2, documentId);
}

type AudioSnapshot = {
  frameBudgetMs: number | null;
  pixelRatio: number;
  issueCode: string | null;
  recoveryAction: string | null;
  unavailableReason: string | null;
  audioState: string | null;
  publishedAudio: boolean;
  audioSource: string | null;
  subscribedAudioCount: number;
  remoteActive: boolean;
  remoteMuted: boolean;
  remoteHasAudioNode: boolean;
  speakerLevel: number;
  spatialLevel: number;
  spatialHasAudioNode: boolean;
  spatialPannerActive: boolean;
  webrtcAvailable: boolean;
  transportCount: number;
  publisherConnected: boolean;
  subscriberConnected: boolean;
  bytesSent: number;
  bytesReceived: number;
};

async function readAudioSnapshot(listener: DemoClient, sourceParticipantId: string): Promise<AudioSnapshot> {
  return listener.page.evaluate((targetParticipantId) => {
    const debug = (window as any).__VRATA_DEBUG__;
    const remote = debug?.remoteParticipants?.find((participant: any) => participant.participantId === targetParticipantId);
    const spatial = debug?.spatialAudio?.remoteSources?.find((source: any) => source.participantId === targetParticipantId);
    const transports = debug?.media?.webrtc?.transports ?? [];
    const publisher = transports.find((transport: any) => transport.role === "publisher");
    const subscriber = transports.find((transport: any) => transport.role === "subscriber");
    const connected = (transport: any) => transport?.connectionState === "connected"
      || transport?.iceConnectionState === "connected"
      || transport?.iceConnectionState === "completed";
    return {
      frameBudgetMs: debug?.avatarPoseTransport?.frameBudgetMs ?? null,
      pixelRatio: devicePixelRatio,
      issueCode: debug?.issueCode ?? null,
      recoveryAction: debug?.lastRecoveryAction ?? null,
      unavailableReason: debug?.media?.webrtc?.unavailableReason ?? null,
      audioState: debug?.media?.audioState ?? null,
      publishedAudio: debug?.media?.publishedAudio ?? false,
      audioSource: debug?.media?.audioSource ?? null,
      subscribedAudioCount: debug?.media?.subscribedAudioCount ?? 0,
      remoteActive: remote?.activeAudio ?? false,
      remoteMuted: remote?.muted ?? true,
      remoteHasAudioNode: remote?.hasAudioNode ?? false,
      speakerLevel: debug?.speakerOutputLevel ?? 0,
      spatialLevel: spatial?.audioLevel ?? 0,
      spatialHasAudioNode: spatial?.hasAudioNode ?? false,
      spatialPannerActive: spatial?.pannerActive ?? false,
      webrtcAvailable: debug?.media?.webrtc?.available ?? false,
      transportCount: transports.length,
      publisherConnected: connected(publisher),
      subscriberConnected: connected(subscriber),
      bytesSent: Math.max(0, ...transports.map((transport: any) => transport.selectedCandidatePair?.bytesSent ?? 0)),
      bytesReceived: Math.max(0, ...transports.map((transport: any) => transport.selectedCandidatePair?.bytesReceived ?? 0))
    };
  }, sourceParticipantId);
}

function audioReady(snapshot: AudioSnapshot): boolean {
  return snapshot.audioState === "joined"
    && snapshot.publishedAudio
    && snapshot.audioSource === "mock"
    && snapshot.subscribedAudioCount >= 1
    && snapshot.remoteActive
    && !snapshot.remoteMuted
    && snapshot.speakerLevel > 0
    && snapshot.spatialLevel > 0
    && snapshot.spatialHasAudioNode
    && snapshot.spatialPannerActive
    && snapshot.webrtcAvailable
    && snapshot.transportCount >= 1
    && (snapshot.publisherConnected || snapshot.subscriberConnected)
    && snapshot.bytesSent > 0
    && snapshot.bytesReceived > 0;
}

async function runStrictStagingAudio(host: DemoClient, member: DemoClient): Promise<void> {
  const mediaTokenStatuses: Array<{ role: DemoRole; status: number }> = [];
  for (const client of [host, member]) {
    client.page.on("response", response => {
      if (new URL(response.url()).pathname === "/api/tokens/media") mediaTokenStatuses.push({ role: client.role, status: response.status() });
    });
    await expect(client.page.locator("#join-muted")).toBeChecked();
    await expect(client.page.locator("#join-audio")).toHaveText("Join Audio Muted");
    await activateButton(client.page, "#join-audio");
    try {
      await expect.poll(() => client.page.evaluate(() => ({
        joined: (window as any).__VRATA_DEBUG__?.media?.audioJoined ?? false,
        published: (window as any).__VRATA_DEBUG__?.media?.publishedAudio ?? false
      })), { timeout: 30_000, intervals: [500, 1_000, 2_000] }).toEqual({ joined: true, published: false });
    } catch {
      const [hostState, memberState] = await Promise.all([
        readAudioSnapshot(host, member.participantId), readAudioSnapshot(member, host.participantId)
      ]);
      throw new Error(`public_demo_muted_join_timeout:${JSON.stringify({ role: client.role, mediaTokenStatuses, hostState, memberState })}`);
    }
    await expect(client.page.locator("#toggle-mute")).toHaveText("Unmute");
    await activateButton(client.page, "#toggle-mute");
  }

  try {
    await expect.poll(async () => {
      const [hostState, memberState] = await Promise.all([
        readAudioSnapshot(host, member.participantId),
        readAudioSnapshot(member, host.participantId)
      ]);
      return audioReady(hostState) && audioReady(memberState);
    }, { timeout: 60_000, intervals: [500, 1_000, 2_000, 3_000] }).toBe(true);
  } catch {
    const [hostState, memberState] = await Promise.all([
      readAudioSnapshot(host, member.participantId),
      readAudioSnapshot(member, host.participantId)
    ]);
    throw new Error(`public_demo_audio_not_ready:${JSON.stringify({ mediaTokenStatuses, hostState, memberState })}`);
  }

  const [hostBaseline, memberBaseline] = await Promise.all([
    readAudioSnapshot(host, member.participantId),
    readAudioSnapshot(member, host.participantId)
  ]);
  await expect.poll(async () => {
    const [hostState, memberState] = await Promise.all([
      readAudioSnapshot(host, member.participantId),
      readAudioSnapshot(member, host.participantId)
    ]);
    return hostState.bytesReceived > hostBaseline.bytesReceived
      && memberState.bytesReceived > memberBaseline.bytesReceived
      && hostState.speakerLevel > 0
      && memberState.speakerLevel > 0;
  }, { timeout: 45_000, intervals: [500, 1_000, 2_000] }).toBe(true);

  await activateButton(member.page, "#toggle-mute");
  await expect.poll(async () => {
    const [hostState, memberState] = await Promise.all([
      readAudioSnapshot(host, member.participantId),
      readAudioSnapshot(member, host.participantId)
    ]);
    return memberState.audioState === "muted"
      && !memberState.publishedAudio
      && hostState.remoteMuted
      && !hostState.remoteActive
      && hostState.subscribedAudioCount === 0
      && hostState.speakerLevel === 0;
  }, { timeout: 45_000, intervals: [500, 1_000, 2_000] }).toBe(true);

  const mutedBaseline = await readAudioSnapshot(host, member.participantId);
  await activateButton(member.page, "#toggle-mute");
  await expect.poll(async () => {
    const hostState = await readAudioSnapshot(host, member.participantId);
    const memberState = await readAudioSnapshot(member, host.participantId);
    return audioReady(hostState)
      && memberState.audioState === "joined"
      && memberState.publishedAudio
      && hostState.bytesReceived > mutedBaseline.bytesReceived
      && hostState.speakerLevel > 0;
  }, { timeout: 60_000, intervals: [500, 1_000, 2_000, 3_000] }).toBe(true);
}

async function attachAllowlistedDiagnostics(
  testInfo: TestInfo,
  environment: "local" | "staging",
  phase: string,
  clients: DemoClient[]
): Promise<void> {
  const clientDiagnostics = await Promise.all(clients.map(async (client) => {
    if (client.page.isClosed()) return { role: client.role, pageOpen: false };
    const state = await client.page.evaluate(() => {
      const debug = (window as any).__VRATA_DEBUG__;
      return {
        connected: debug?.roomStateConnected ?? false,
        sceneState: debug?.sceneBundleState ?? null,
        accessRole: debug?.access?.role ?? null,
        roleQueryAllowed: debug?.access?.roleQueryAllowed ?? null,
        remoteCount: debug?.remoteAvatarCount ?? null,
        notesState: debug?.notes?.saveState ?? null,
        presentationState: debug?.pdfPresentation?.renderState ?? null,
        presentationPage: debug?.pdfPresentation?.page ?? null,
        mediaState: debug?.media?.audioState ?? null,
        audioSource: debug?.media?.audioSource ?? null,
        webrtcAvailable: debug?.media?.webrtc?.available ?? false,
        transportCount: debug?.media?.webrtc?.transports?.length ?? 0,
        issueCode: debug?.issueCode ?? null
      };
    }).catch(() => null);
    return { role: client.role, pageOpen: true, state };
  }));
  await testInfo.attach("public-demo-diagnostics", {
    body: JSON.stringify({ environment, phase, clientCount: clients.length, clients: clientDiagnostics }, null, 2),
    contentType: "application/json"
  });
}

async function attachCleanupRecord(
  demo: PublicDemoModule,
  testInfo: TestInfo,
  environment: "local" | "staging",
  cleanupRecord: string
): Promise<void> {
  const record = await demo.readPublicDemoState(cleanupRecord, { allowCleanupRecord: true });
  await testInfo.attach("public-demo-cleanup-record", {
    body: JSON.stringify({
      environment,
      schemaVersion: record.schemaVersion,
      kind: record.kind,
      runId: record.runId,
      tenantId: record.tenantId,
      roomId: record.roomId,
      resources: {
        documentIds: record.resources?.documentIds ?? [],
        inviteIds: record.resources?.inviteIds ?? []
      },
      cleanup: record.lifecycle?.cleanup ?? null
    }, null, 2),
    contentType: "application/json"
  });
}

async function supplementalInvites(origin: string, adminToken: string, roomId: string): Promise<{
  expiredLink: string;
  revokedLink: string;
}> {
  const expired = await adminJson(origin, adminToken, `/api/rooms/${roomId}/invites`, {
    method: "POST",
    body: JSON.stringify({ role: "guest", expiresAt: new Date(Date.now() - 60_000).toISOString(), waitingRoomEnabled: false })
  }, "public_demo_create_expired_invite");
  requireStatus(expired.status, 201, "public_demo_create_expired_invite");
  const expiredLink = typeof expired.data.inviteLink === "string" ? expired.data.inviteLink : "";
  inviteToken(expiredLink);

  const revoked = await adminJson(origin, adminToken, `/api/rooms/${roomId}/invites`, {
    method: "POST",
    body: JSON.stringify({ role: "guest", expiresInSeconds: 3_600, waitingRoomEnabled: false })
  }, "public_demo_create_revoked_invite");
  requireStatus(revoked.status, 201, "public_demo_create_revoked_invite");
  const revokedLink = typeof revoked.data.inviteLink === "string" ? revoked.data.inviteLink : "";
  const revokedId = typeof revoked.data.inviteId === "string" ? revoked.data.inviteId : "";
  inviteToken(revokedLink);
  if (!revokedId) throw new Error("public_demo_revoked_invite_invalid");
  const revoke = await adminJson(origin, adminToken, `/api/rooms/${roomId}/invites/${encodeURIComponent(revokedId)}/revoke`, {
    method: "POST"
  }, "public_demo_revoke_invite");
  requireStatus(revoke.status, 200, "public_demo_revoke_invite");
  return { expiredLink, revokedLink };
}

export async function assertExactActivePublicDemoCatalog(origin: string): Promise<void> {
  const catalog = await fetchJson(origin, "/api/templates", { method: "GET" }, "public_demo_catalog_preflight");
  requireStatus(catalog.status, 200, "public_demo_catalog_preflight");
  const actual = Array.isArray(catalog.data.items)
    ? catalog.data.items.map((item: JsonRecord) => ({
      templateId: item.templateId,
      currentVersion: item.currentVersion,
      status: item.status
    })).sort((left: JsonRecord, right: JsonRecord) => String(left.templateId).localeCompare(String(right.templateId)))
    : [];
  if (JSON.stringify(actual) !== JSON.stringify(expectedCatalog)) {
    throw new Error("public_demo_exact_active_catalog_required");
  }
}

export async function runPublicDemoScenario(options: PublicDemoScenarioOptions): Promise<void> {
  const demo = await loadPublicDemoModule();
  const stateDirectory = await mkdtemp(join(tmpdir(), "vrata-public-demo-e2e-"));
  const stateFile = join(stateDirectory, "private-state.json");
  const cleanupRecord = demo.publicDemoCleanupRecordPath(stateFile);
  const contexts: BrowserContext[] = [];
  const clients: DemoClient[] = [];
  const pdfCaptures = new Map<Page, PdfCommandCapture>();
  const environment = options.staging ? "staging" : "local";
  let phase = "seed";
  let primaryError: unknown;
  let cleanupFailed = false;
  let hostDocumentId: string | null = null;
  const setPhase = (next: string) => {
    phase = next;
    console.log(`public-demo:${environment}:${next}`);
  };

  if (!options.staging) {
    options.testInfo.annotations.push({
      type: "voice-acceptance",
      description: "Not assessed: the local reference fixture has no LiveKit media service."
    });
  }

  try {
    await demo.seedPublicDemo({
      baseUrl: options.origin,
      stateFile,
      adminToken: options.adminToken,
      inviteTtlSeconds: 3_600,
      timeoutMs: requestTimeoutMs,
      onCleanupRecord: (record: JsonRecord) => {
        console.log(`public-demo:planned:${JSON.stringify({ runId: record.runId, origin: record.origin, tenantId: record.tenantId, roomId: record.roomId, planned: record.planned })}`);
      }
    });
    const state = await demo.readPublicDemoState(stateFile);
    const roomId = state.roomId as string;
    const hostInvite = state.resources.invites.find((invite: JsonRecord) => invite.role === "host")?.inviteLink;
    const memberInvites = state.resources.invites.filter((invite: JsonRecord) => invite.role === "member").map((invite: JsonRecord) => invite.inviteLink);
    const guestInvite = state.resources.invites.find((invite: JsonRecord) => invite.role === "guest")?.inviteLink;
    if (typeof hostInvite !== "string" || memberInvites.length !== 2 || memberInvites.some((link: unknown) => typeof link !== "string") || typeof guestInvite !== "string") {
      throw new Error("public_demo_seeded_invites_invalid");
    }
    const negativeInvites = await supplementalInvites(options.origin, options.adminToken, roomId);
    const invalidInviteLink = new URL(`/rooms/${roomId}`, options.origin);
    invalidInviteLink.searchParams.set("invite", "invalid-public-demo-invite-token");

    setPhase("access-denials");
    await expectStateTokenDenied(options.origin, roomId, {}, "invite_required", "public_demo_direct_room_denial");
    await expectStateTokenDenied(options.origin, roomId, { inviteToken: inviteToken(invalidInviteLink.href) }, "invite_required", "public_demo_invalid_invite_denial");
    await expectStateTokenDenied(options.origin, roomId, { inviteToken: inviteToken(negativeInvites.expiredLink) }, "invite_expired", "public_demo_expired_invite_denial");
    await expectStateTokenDenied(options.origin, roomId, { inviteToken: inviteToken(negativeInvites.revokedLink) }, "invite_revoked", "public_demo_revoked_invite_denial");
    const requestedHost = await requestStateToken(options.origin, roomId, {
      inviteToken: inviteToken(guestInvite),
      requestedRole: "host"
    }, "public_demo_guest_role_query_server_check");
    requireStatus(requestedHost.status, 200, "public_demo_guest_role_query_server_check");
    assertTrustedSession(requestedHost.data, "guest");

    const deniedContext = await createTrackedContext(options.browser);
    contexts.push(deniedContext);
    const deniedPage = await deniedContext.newPage();
    await expectDirectRoomBrowserDenied(deniedPage, options.origin, roomId);
    await expectInviteBrowserDenied(deniedPage, invalidInviteLink.href, "Invalid Demo Invite", "Access denied: private invite required");
    await expectInviteBrowserDenied(deniedPage, negativeInvites.expiredLink, "Expired Demo Invite", "Access denied: invite link expired");
    await expectInviteBrowserDenied(deniedPage, negativeInvites.revokedLink, "Revoked Demo Invite", "Access denied: invite link revoked");
    await deniedContext.close();
    contexts.pop();
    for (let index = 0; index < 4; index += 1) contexts.push(await createTrackedContext(options.browser));

    setPhase("four-participant-join");
    let hostPage = await contexts[0]!.newPage();
    const host = await joinClientPage({
      context: contexts[0]!, page: hostPage, role: "host", inviteLink: hostInvite,
      displayName: "Public Demo Host", audioMock: options.staging, requireDevRoleQueryDisabled: !options.staging,
      pdfCaptures
    });
    clients.push(host);
    console.log(`public-demo:${environment}:host-joined`);
    let firstMemberPage = await contexts[1]!.newPage();
    const firstMember = await joinClientPage({
      context: contexts[1]!, page: firstMemberPage, role: "member", inviteLink: memberInvites[0] as string,
      displayName: "Public Demo Member One", audioMock: options.staging, requireDevRoleQueryDisabled: !options.staging
    });
    clients.push(firstMember);
    console.log(`public-demo:${environment}:member-one-joined`);

    if (options.staging) {
      await waitForExactPresence([host, firstMember]);
      setPhase("strict-livekit-audio");
      await runStrictStagingAudio(host, firstMember);
      for (const client of [host, firstMember]) await activateButton(client.page, "#join-audio");
      await expect.poll(async () => Promise.all([host, firstMember].map(client => client.page.evaluate(() => (window as any).__VRATA_DEBUG__?.media?.audioState))), {
        timeout: 45_000, intervals: corePollIntervals
      }).toEqual(["not_joined", "not_joined"]);
    }

    let secondMemberPage = await contexts[2]!.newPage();
    const secondMember = await joinClientPage({
      context: contexts[2]!, page: secondMemberPage, role: "member", inviteLink: memberInvites[1] as string,
      displayName: "Public Demo Member Two", audioMock: false, requireDevRoleQueryDisabled: !options.staging
    });
    clients.push(secondMember);
    console.log(`public-demo:${environment}:member-two-joined`);
    let guestPage = await contexts[3]!.newPage();
    const guest = await joinClientPage({
      context: contexts[3]!, page: guestPage, role: "guest", inviteLink: guestInvite,
      displayName: "Public Demo Guest", audioMock: false, requireDevRoleQueryDisabled: !options.staging
    });
    clients.push(guest);
    console.log(`public-demo:${environment}:guest-joined`);
    if (new Set(clients.map((client) => client.participantId)).size !== 4) throw new Error("public_demo_participant_ids_not_unique");
    await waitForExactPresence(clients);

    setPhase("host-own-document-upload");
    await expect(host.page.locator("#documents-panel")).toBeVisible();
    await expect(host.page.locator("#document-select")).toBeEnabled({ timeout: 30_000 });
    await expect(host.page.locator("#document-select")).toHaveValue(state.resources.document.documentId, { timeout: 30_000 });
    const ownDocumentId = await uploadHostDocument(host, roomId, options.testInfo);
    hostDocumentId = ownDocumentId;
    setPhase("presentation-page-one");
    await expect(host.page.locator("#media-surface-select")).toHaveValue("debug-main");
    await expect(host.page.locator("#document-surface-button")).toBeEnabled({ timeout: 30_000 });
    await activateButton(host.page, "#document-surface-button", {
      capture: host.pdfCapture!, documentId: ownDocumentId, operation: "select-document", expectedPage: 1
    });

    setPhase("shared-notes");
    const note = "# Public demo decision\n- Keep the production invite flow.";
    await secondMember.page.bringToFront();
    await expect(secondMember.page.locator("#notes-scope-select")).toHaveValue("shared");
    await expect(secondMember.page.locator("#notes-editor")).toBeEnabled();
    await secondMember.page.locator("#notes-editor").evaluate((editor: HTMLTextAreaElement, value) => {
      editor.value = value;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    }, note);
    await expect.poll(() => secondMember.page.evaluate(() => ({
      saveState: (window as any).__VRATA_DEBUG__?.notes?.saveState ?? null,
      status: document.querySelector("#notes-status")?.textContent ?? null
    })), {
      timeout: 30_000,
      intervals: corePollIntervals
    }).toEqual({ saveState: "saved", status: "Notes saved" });
    const savedNote = await sessionRequest(options.origin, roomId, secondMember.sessionToken, "/notes/shared", { method: "GET" }, "public_demo_member_note_confirmation");
    requireStatus(savedNote.status, 200, "public_demo_member_note_confirmation");
    if (savedNote.data.note?.content !== note) throw new Error("public_demo_member_note_not_persisted");
    await expect(guest.page.locator("#notes-editor")).toBeDisabled();
    await expect(guest.page.locator("#notes-status")).toContainText("Notes read-only");
    const guestNoteWrite = await sessionRequest(options.origin, roomId, guest.sessionToken, "/notes/shared", {
      method: "PUT",
      body: JSON.stringify({ content: "Guest must not overwrite the shared note." })
    }, "public_demo_guest_note_write");
    requireStatus(guestNoteWrite.status, 403, "public_demo_guest_note_write");

    setPhase("presentation-page-two");
    await waitForPresentation([host], 1, ownDocumentId);
    await activateButton(host.page, "#presentation-next", {
      capture: host.pdfCapture!, documentId: ownDocumentId, operation: "go-to-page", expectedPage: 2
    });
    await waitForPresentation(clients, 2, ownDocumentId);

    await leaveClient(guest, options.origin, roomId);
    await waitForExactPresence([host, firstMember, secondMember]);
    guest.page = await guest.context.newPage();
    const [, rejoinedGuest] = await Promise.all([
      reloadClientThroughInvite(firstMember),
      joinClientPage(guest)
    ]);
    guest.page = rejoinedGuest.page;
    guest.participantId = rejoinedGuest.participantId;
    guest.sessionToken = rejoinedGuest.sessionToken;
    if (new Set(clients.map((client) => client.participantId)).size !== 4) throw new Error("public_demo_rejoin_participant_ids_not_unique");
    await Promise.all([
      waitForPresentation([firstMember, guest], 2, ownDocumentId),
      waitForExactPresence(clients)
    ]);
    await expect(firstMember.page.locator("#notes-editor")).toHaveValue(note, { timeout: 15_000 });

    await expect(guest.page.locator("#notes-editor")).toHaveValue(note, { timeout: 15_000 });
    await expect(guest.page.locator("#notes-editor")).toBeDisabled();
    const memberSessionControl = await sessionRequest(options.origin, roomId, firstMember.sessionToken, "/session-control/lock", {
      method: "POST"
    }, "public_demo_member_session_control");
    requireStatus(memberSessionControl.status, 403, "public_demo_member_session_control");
    const guestSessionControl = await sessionRequest(options.origin, roomId, guest.sessionToken, "/session-control/lock", {
      method: "POST"
    }, "public_demo_guest_session_control");
    requireStatus(guestSessionControl.status, 403, "public_demo_guest_session_control");
    await denyGuestPresentationControl(guest, roomId, ownDocumentId);

    setPhase("presentation-page-three");
    await activateButton(host.page, "#presentation-next", {
      capture: host.pdfCapture!, documentId: ownDocumentId, operation: "go-to-page", expectedPage: 3
    });
    await waitForPresentation(clients, 3, ownDocumentId);

    setPhase("host-lock-unlock-remove");
    await leaveClient(guest, options.origin, roomId);
    setPhase("host-lock-guest-left");
    await waitForExactPresence([host, firstMember, secondMember]);
    await activateButton(host.page, "#lock-room");
    setPhase("host-lock-active");
    await expect.poll(async () => {
      const result = await adminJson(options.origin, options.adminToken, `/api/rooms/${roomId}/session-control`, { method: "GET" }, "public_demo_lock_state");
      return result.status === 200 && Boolean(result.data.state?.lockedAt);
    }, { timeout: 120_000, intervals: [500, 1_000, 2_000] }).toBe(true);
    await expect(host.page.locator("#host-controls-status")).toContainText("Room locked", { timeout: 120_000 });
    await expectStateTokenDenied(options.origin, roomId, { inviteToken: inviteToken(guest.inviteLink) }, "room_locked", "public_demo_locked_guest_denial");
    setPhase("host-lock-denial-confirmed");
    await activateButton(host.page, "#unlock-room");
    setPhase("host-lock-released");
    await expect.poll(async () => {
      const result = await adminJson(options.origin, options.adminToken, `/api/rooms/${roomId}/session-control`, { method: "GET" }, "public_demo_unlock_state");
      return result.status === 200 && !result.data.state?.lockedAt;
    }, { timeout: 120_000, intervals: [500, 1_000, 2_000] }).toBe(true);
    await expect(host.page.locator("#host-controls-status")).toContainText(/Room (unlocked|open)/, { timeout: 120_000 });
    guest.page = await guest.context.newPage();
    const unlockedGuest = await joinClientPage(guest);
    guest.page = unlockedGuest.page;
    guest.participantId = unlockedGuest.participantId;
    guest.sessionToken = unlockedGuest.sessionToken;
    setPhase("host-lock-guest-rejoined");
    await waitForExactPresence(clients);

    await expect.poll(async () => host.page.locator("#host-participant-select").evaluate((select, participantId) =>
      Array.from((select as HTMLSelectElement).options).some((option) => option.value === participantId), guest.participantId), {
      timeout: 30_000,
      intervals: corePollIntervals
    }).toBe(true);
    await host.page.locator("#host-participant-select").selectOption(guest.participantId);
    const removalResponse = host.page.waitForResponse((response) => {
      const request = response.request();
      return request.method() === "POST"
        && new URL(response.url()).pathname === `/api/rooms/${roomId}/participants/${guest.participantId}/remove`;
    }, { timeout: 30_000 });
    await activateButton(host.page, "#remove-participant");
    setPhase("host-remove-dispatched");
    requireStatus((await removalResponse).status(), 200, "public_demo_host_remove_guest");
    await waitForExactPresence([host, firstMember, secondMember]);
    const blockedGuest = await sessionRequest(options.origin, roomId, guest.sessionToken, "/session-control", { method: "GET" }, "public_demo_removed_guest_server_state");
    requireStatus(blockedGuest.status, 200, "public_demo_removed_guest_server_state");
    if (blockedGuest.data.participant?.status !== "blocked" || blockedGuest.data.participant?.reason !== "participant_removed") {
      throw new Error("public_demo_removed_guest_not_blocked_on_server");
    }
    setPhase("host-remove-server-confirmed");
    await guest.page.bringToFront();
    await expect(guest.page.locator("#status-line")).toContainText("Access denied: removed by host", { timeout: 120_000 });
    phase = "completed";
  } catch (error) {
    primaryError = error;
    await attachAllowlistedDiagnostics(options.testInfo, environment, phase, clients).catch(() => undefined);
  } finally {
    try {
      const captures = await Promise.all(Array.from(pdfCaptures, async ([page, capture]) => {
        const finalPreconditions = page.isClosed() ? null : await page.evaluate(pdfActionSnapshot, {
          selector: "#document-surface-button", documentId: hostDocumentId, activate: false
        }).then(value => value.before).catch(() => null);
        return { ...capture.snapshot(), finalPreconditions };
      }));
      if (pdfCaptures.size) await options.testInfo.attach("public-demo-pdf-command-evidence", {
        body: JSON.stringify({ environment, phase, captures }, null, 2),
        contentType: "application/json"
      }).catch(() => undefined);
    } finally {
      await Promise.allSettled(Array.from(pdfCaptures.values(), capture => capture.close()));
    }
    await Promise.allSettled(contexts.map((context) => context.close()));
    try {
      const cleanupInput = await pathExists(stateFile)
        ? stateFile
        : await pathExists(cleanupRecord) ? cleanupRecord : null;
      if (cleanupInput) {
        await demo.cleanupPublicDemo({
          stateFile: cleanupInput,
          baseUrl: options.origin,
          adminToken: options.adminToken,
          timeoutMs: requestTimeoutMs
        });
      }
    } catch {
      cleanupFailed = true;
      if (await pathExists(cleanupRecord)) {
        await attachCleanupRecord(demo, options.testInfo, environment, cleanupRecord).catch(() => undefined);
      }
    } finally {
      if (await pathExists(cleanupRecord)) {
        await attachCleanupRecord(demo, options.testInfo, environment, cleanupRecord).catch(() => undefined);
      }
      await rm(stateDirectory, { recursive: true, force: true });
    }
  }

  if (primaryError && cleanupFailed) {
    throw new AggregateError([primaryError, new Error("public_demo_cleanup_failed")], "public_demo_scenario_and_cleanup_failed");
  }
  if (primaryError) throw primaryError;
  if (cleanupFailed) throw new Error("public_demo_cleanup_failed");
}
