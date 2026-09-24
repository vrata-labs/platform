import assert from "node:assert/strict";
import {
  PDF_PRESENTATION_OBJECT_TYPE, IMAGE_VIEWER_OBJECT_TYPE, VIDEO_PLAYER_OBJECT_TYPE,
  type MediaObjectInstance, type PdfPresentationState, type ImageViewerState, type VideoPlayerState
} from "@vrata/shared-types";
import { createDocumentSurfaceActions, type DocumentSurfaceActionsContext } from "../document-surface-actions.js";
import type { RuntimeDocumentRecord } from "../index.js";
import type { SurfaceCommandResult } from "../room-state-client.js";

export type DocumentKind = "pdf" | "image" | "video";
export type CommandName = keyof DocumentSurfaceActionsContext["mediaSurfaceCommands"];
export const kinds: DocumentKind[] = ["pdf", "image", "video"];
export const commandsFor = {
  pdf: ["createPdfPresentationObjectOnSurface", "patchPdfPresentationObject", "stopPdfPresentationObject"],
  image: ["createImageViewerObjectOnSurface", "patchImageViewerObject", "stopImageViewerObject"],
  video: ["createVideoPlayerObjectOnSurface", "patchVideoPlayerObject", "stopVideoPlayerObject"]
} as const;
export const accepted = (values: Partial<SurfaceCommandResult> = {}): SurfaceCommandResult => ({
  accepted: true, permission: "document.present", role: "host", ...values
});
export function makeDocument(kind: DocumentKind, id = "selected"): RuntimeDocumentRecord {
  return {
    documentId: id, roomId: "room", tenantId: "tenant", filename: `${id}.${kind}`,
    contentType: kind === "pdf" ? "application/pdf" : kind === "image" ? "image/png" : "video/mp4",
    sizeBytes: 100, checksum: `checksum-${id}`, uploadedAt: "2026-01-01T00:00:00Z",
    downloadUrl: `/documents/${id}`, linkedSurfaceId: null,
    metadata: { kind, pageCount: 7, widthPx: 640, heightPx: 480, durationMs: 9000 }
  };
}
export function makeObject<K extends DocumentKind>(kind: K, documentId: string | null = "previous") {
  const common = { status: "active" as const, documentId, filename: "previous", checksum: "checksum", lastInputEventId: null };
  const states = {
    pdf: { ...common, pageCount: 4, currentPage: 2, displayMode: "normal" as const },
    image: { ...common, contentType: "image/png" as const, widthPx: 100, heightPx: 50, fitMode: "contain" as const },
    video: { ...common, contentType: "video/mp4" as const, widthPx: 100, heightPx: 50, fitMode: "contain" as const,
      durationMs: 6000, playbackState: "paused" as const, positionMs: 0, anchorServerTimeMs: null, loop: false }
  };
  const types = { pdf: PDF_PRESENTATION_OBJECT_TYPE, image: IMAGE_VIEWER_OBJECT_TYPE, video: VIDEO_PLAYER_OBJECT_TYPE };
  return { objectId: `${kind}-object`, roomId: "room", type: types[kind], surfaceId: "object-surface",
    ownerParticipantId: "owner", state: states[kind], status: "active", revision: 12, createdAtMs: 1, updatedAtMs: 2
  } as MediaObjectInstance<{ pdf: PdfPresentationState; image: ImageViewerState; video: VideoPlayerState }[K]>;
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
export function createHarness(kind: DocumentKind = "pdf") {
  const state = {
    selected: makeDocument(kind) as RuntimeDocumentRecord | null, canPresent: true,
    occupied: null as MediaObjectInstance | null,
    pdf: null as MediaObjectInstance<PdfPresentationState> | null,
    image: null as MediaObjectInstance<ImageViewerState> | null,
    video: null as MediaObjectInstance<VideoPlayerState> | null
  };
  const events: Array<{ name: string; args: unknown[] }> = [];
  const hooks: {
    commands: Partial<Record<CommandName, (...args: unknown[]) => SurfaceCommandResult | Promise<SurfaceCommandResult>>>;
    link?: (documentId: string, surfaceId: string | null, token: string) => Promise<RuntimeDocumentRecord>;
  } = { commands: {} };
  const log = (name: string, ...args: unknown[]) => { events.push({ name, args }); };
  const mediaSurfaceCommands = Object.fromEntries(Object.values(commandsFor).flat().map((name) => [name,
    function (this: unknown, ...args: unknown[]) {
      assert.equal(this, mediaSurfaceCommands);
      log(name, ...args);
      return hooks.commands[name]?.(...args) ?? Promise.resolve(accepted({ objectId: "created", revision: 3 }));
    }
  ])) as DocumentSurfaceActionsContext["mediaSurfaceCommands"];
  const context = {
    apiBaseUrl: "https://example.invalid", roomId: "room", participantId: "participant",
    selectedMediaSurfaceId: "selected-surface", roomStateAccessToken: "token-1",
    roomDocuments: [state.selected!] as RuntimeDocumentRecord[], presentationActionInFlight: false as boolean,
    selectedDocument() { log("selectedDocument"); return state.selected; },
    canPresentDocuments() { log("canPresentDocuments"); return state.canPresent; },
    setDocumentStatus(message: string, errorCode: string | null = null) {
      log("status", message, errorCode); context.documentStatusEl.textContent = message;
    },
    documentErrorCode(error: unknown) {
      return (error instanceof Error ? error.message : String(error)).split(":").slice(0, 3).join(":") || "document_error";
    },
    presentationInputEventId(kind: string) { log("presentationId", kind); return `pdf:${kind}`; },
    documentMediaInputEventId(kind: string) { log("mediaId", kind); return `media:${kind}`; },
    activeMediaObjectForSurface(surfaceId: string) { log("occupied", surfaceId); return state.occupied; },
    activePdfPresentationObjectForSurface(surfaceId: string) { log("activePdf", surfaceId); return state.pdf; },
    activeImageViewerObjectForSurface(surfaceId: string) { log("activeImage", surfaceId); return state.image; },
    activeVideoPlayerObjectForSurface(surfaceId: string) { log("activeVideo", surfaceId); return state.video; },
    currentPdfPresentationObject() { log("currentPdf"); return state.pdf; },
    currentImageViewerObject() { log("currentImage"); return state.image; },
    currentVideoPlayerObject() { log("currentVideo"); return state.video; },
    renderDocumentsUi(message?: string) { log("renderDocuments", message, context.presentationActionInFlight); },
    renderPresentationControls() { log("renderPresentation", context.presentationActionInFlight); },
    renderDocumentMediaControls() { log("renderMedia", context.presentationActionInFlight); },
    documentStatusEl: { textContent: "initial" },
    presentationStatusEl: { textContent: "initial" },
    documentMediaStatusEl: { textContent: "initial" },
    debugState: { pdfPresentation: { errorCode: null as string | null } },
    mediaSurfaceCommands,
    selectRoomDocumentSurface: async function (this: unknown, base: string, room: string, id: string, surface: string | null, token: string) {
      assert.equal(this, undefined);
      log("link", base, room, id, surface, token);
      return hooks.link ? hooks.link(id, surface, token) : { ...makeDocument(kind, id), linkedSurfaceId: surface };
    }
  } satisfies DocumentSurfaceActionsContext;
  const setObject = (kind: DocumentKind, documentId: string | null = "previous") => {
    if (kind === "pdf") state.pdf = makeObject("pdf", documentId);
    else if (kind === "image") state.image = makeObject("image", documentId);
    else state.video = makeObject("video", documentId);
  };
  const actions = createDocumentSurfaceActions(context);
  return { state, context, hooks, events, actions, setObject,
    calls: (name: string) => events.filter((event) => event.name === name).map((event) => event.args) };
}
