import { hasRoomPermission, type DocumentUploadPolicy } from "@vrata/shared-types";
import type * as RuntimeApi from "./index.js";
import type { RuntimeDocumentRecord } from "./index.js";
import type { probeDocumentMedia } from "./document-media-probe.js";
import type { createRuntimeDebugState } from "./runtime-debug-state.js";
import { createDocumentFeedback, safeDocumentErrorCode, type DocumentOperation } from "./document-feedback.js";
import { documentUploadPolicyView } from "./document-upload-policy.js";
import { createDocumentLibraryActions } from "./document-library-actions.js";

type RuntimeDebugState = ReturnType<typeof createRuntimeDebugState>;

export interface DocumentLibraryContext {
  apiBaseUrl: string;
  roomId: string;
  // Main and surface actions retain ownership of these live bindings.
  readonly runtimeFlags: { documentsEnabled: boolean };
  readonly roomStateConnected: boolean;
  readonly roomStateAccessToken: string;
  readonly presentationActionInFlight: boolean;
  readonly sessionControlBlocked: boolean;
  roomDocuments: RuntimeDocumentRecord[];
  selectedDocumentId: string;
  debugState: {
    access: Pick<RuntimeDebugState["access"], "permissions">;
    documents: RuntimeDebugState["documents"];
  };
  documentsPanelEl: Pick<HTMLElement, "hidden" | "setAttribute">;
  documentUploadInput: Pick<HTMLInputElement, "disabled" | "value" | "setAttribute"> & { files: ArrayLike<File> | null };
  documentUploadPolicyEl: Pick<HTMLElement, "textContent">;
  documentOperationProgressEl: Pick<HTMLElement, "hidden" | "setAttribute">;
  documentUploadButton: Pick<HTMLButtonElement, "disabled">;
  documentSelect: Pick<HTMLSelectElement, "disabled" | "replaceChildren">;
  documentDownloadButton: Pick<HTMLButtonElement, "disabled">;
  documentSurfaceButton: Pick<HTMLButtonElement, "disabled">;
  documentDeleteButton: Pick<HTMLButtonElement, "disabled">;
  documentRefreshButton: Pick<HTMLButtonElement, "disabled">;
  documentStatusEl: Pick<HTMLElement, "textContent">;
  renderPresentationControls: () => void;
  renderDocumentMediaControls: () => void;
  listRoomDocuments: typeof RuntimeApi.listRoomDocuments;
  uploadRoomDocument: typeof RuntimeApi.uploadRoomDocument;
  downloadRoomDocument: typeof RuntimeApi.downloadRoomDocument;
  deleteRoomDocument: typeof RuntimeApi.deleteRoomDocument;
  probeDocumentMedia: typeof probeDocumentMedia;
}

export function createDocumentLibraryRuntime(context: DocumentLibraryContext) {
  const {
    apiBaseUrl, roomId, debugState, documentsPanelEl, documentUploadInput,
    documentUploadButton, documentSelect, documentDownloadButton, documentUploadPolicyEl, documentOperationProgressEl,
    documentSurfaceButton, documentDeleteButton, documentRefreshButton, documentStatusEl,
    renderPresentationControls, renderDocumentMediaControls,
    listRoomDocuments, uploadRoomDocument, downloadRoomDocument,
    deleteRoomDocument, probeDocumentMedia
  } = context;

  let documentsLoading = false;
  let documentUploadInFlight = false;
  const documentOperationsInFlight: Record<DocumentOperation, boolean> = { download: false, delete: false };
  let uploadPolicy: DocumentUploadPolicy | null = null;
  const documentFeedback = createDocumentFeedback();
  const permissions = () => ({ view: canViewDocuments(), upload: canUploadDocuments(), download: canDownloadDocuments(), delete: canDeleteDocuments() });
  let lastPermissions = permissions();
  let libraryObserved = false;
  let libraryLoadAttempted = false;

  function canViewDocuments(): boolean {
    return !context.sessionControlBlocked && context.runtimeFlags.documentsEnabled && hasRoomPermission(debugState.access.permissions, "document.view");
  }

  function canUploadDocuments(): boolean {
    return canViewDocuments() && hasRoomPermission(debugState.access.permissions, "document.upload");
  }

  function canDownloadDocuments(): boolean {
    return canViewDocuments() && hasRoomPermission(debugState.access.permissions, "document.download");
  }

  function canDeleteDocuments(): boolean {
    return canViewDocuments() && hasRoomPermission(debugState.access.permissions, "document.delete");
  }

  function canPresentDocuments(): boolean {
    return canViewDocuments() && context.roomStateConnected && hasRoomPermission(debugState.access.permissions, "document.present");
  }

  function selectedDocument(): RuntimeDocumentRecord | null {
    return context.roomDocuments.find((document) => document.documentId === context.selectedDocumentId) ?? context.roomDocuments[0] ?? null;
  }

  function documentErrorCode(error: unknown): string {
    return safeDocumentErrorCode(error);
  }

  function setDocumentStatus(message: string, errorCode: string | null = null): void {
    documentFeedback.set(message, errorCode);
    renderDocumentStatus();
  }

  function renderDocumentStatus(): void {
    const { message, errorCode } = documentFeedback.read({ visible: canViewDocuments(), enabled: context.runtimeFlags.documentsEnabled,
      uploading: documentUploadInFlight, loading: documentsLoading, count: context.roomDocuments.length });
    documentStatusEl.textContent = message;
    const selected = selectedDocument();
    debugState.documents = {
      enabled: context.runtimeFlags.documentsEnabled,
      count: context.roomDocuments.length,
      selectedDocumentId: selected?.documentId ?? "",
      selectedFilename: selected?.filename ?? null,
      selectedSurfaceId: selected?.linkedSurfaceId ?? null,
      lastStatus: message,
      errorCode
    };
  }

  function renderDocumentsUi(message?: string): void {
    const next = permissions();
    const previous = lastPermissions;
    lastPermissions = next;
    if (previous.view && !next.view) {
      actions.invalidate();
      documentFeedback.clear();
      uploadPolicy = null; libraryObserved = false; libraryLoadAttempted = false;
    } else {
      for (const operation of ["download", "upload", "delete"] as const) if (previous[operation] && !next[operation]) actions.revokeOperation(operation);
    }
    if (message !== undefined) documentFeedback.keepOrSet(message);
    const policy = documentUploadPolicyView(uploadPolicy);
    documentUploadPolicyEl.textContent = uploadPolicy || libraryObserved ? policy.description
      : documentsLoading || !libraryLoadAttempted ? "Checking server upload limits…"
        : "Upload limits could not be loaded. Refresh the library to retry; the server validates files on upload.";
    documentUploadInput.setAttribute("accept", policy.accept);
    const busy = documentsLoading || documentUploadInFlight || documentOperationsInFlight.download || documentOperationsInFlight.delete;
    documentsPanelEl.setAttribute("aria-busy", String(busy));
    documentOperationProgressEl.hidden = !busy;
    documentOperationProgressEl.setAttribute("aria-label", documentUploadInFlight ? "Uploading document" : documentsLoading ? "Loading documents"
      : documentOperationsInFlight.download ? "Downloading document" : "Deleting document");
    const visible = canViewDocuments();
    documentsPanelEl.hidden = !visible;
    if (!visible) {
      documentUploadInput.disabled = true;
      documentUploadButton.disabled = true;
      documentSelect.disabled = true;
      documentDownloadButton.disabled = true;
      documentSurfaceButton.disabled = true;
      documentDeleteButton.disabled = true;
      documentRefreshButton.disabled = true;
      renderDocumentStatus();
      return;
    }

    const selected = selectedDocument();
    if (selected && selected.documentId !== context.selectedDocumentId) {
      context.selectedDocumentId = selected.documentId;
      localStorage.setItem(`vrata.documents.selected.${roomId}`, context.selectedDocumentId);
    }
    documentSelect.replaceChildren(
      ...(context.roomDocuments.length > 0
        ? context.roomDocuments.map((doc) => {
          const option = document.createElement("option");
          option.value = doc.documentId;
          const detail = doc.metadata?.pageCount
            ? ` · ${doc.metadata.pageCount} pages`
            : doc.metadata?.widthPx && doc.metadata?.heightPx ? ` · ${doc.metadata.widthPx}×${doc.metadata.heightPx}` : "";
          option.textContent = `${doc.filename}${detail} (${Math.ceil(doc.sizeBytes / 1024)} KB)`;
          option.selected = doc.documentId === context.selectedDocumentId;
          return option;
        })
        : [new Option("No documents", "")])
    );
    documentUploadInput.disabled = !canUploadDocuments() || documentsLoading || documentUploadInFlight;
    documentUploadButton.disabled = !canUploadDocuments() || documentsLoading || documentUploadInFlight;
    documentSelect.disabled = documentsLoading || context.roomDocuments.length === 0;
    documentDownloadButton.disabled = !selected || !canDownloadDocuments() || documentsLoading || documentOperationsInFlight.download;
    documentSurfaceButton.disabled = !selected || !["pdf", "image", "video"].includes(selected.metadata?.kind ?? "") || !canPresentDocuments() || documentsLoading || context.presentationActionInFlight;
    documentDeleteButton.disabled = !selected || !canDeleteDocuments() || documentsLoading || documentOperationsInFlight.delete;
    documentRefreshButton.disabled = documentsLoading;
    renderDocumentStatus();
    renderPresentationControls();
    renderDocumentMediaControls();
  }

  const actions = createDocumentLibraryActions({
    apiBaseUrl, roomId, canViewDocuments, canUploadDocuments, canDownloadDocuments, canDeleteDocuments, selectedDocument,
    selectedFile: () => documentUploadInput.files?.[0], clearFile: () => { documentUploadInput.value = ""; },
    setDocumentStatus, renderDocumentsUi,
    listRoomDocuments: (...args) => listRoomDocuments(...args),
    uploadRoomDocument: (...args) => uploadRoomDocument(...args),
    downloadRoomDocument: (...args) => downloadRoomDocument(...args),
    deleteRoomDocument: (...args) => deleteRoomDocument(...args),
    saveDownload(download) {
      const link = document.createElement("a");
      const objectUrl = URL.createObjectURL(download.blob);
      try {
        link.href = objectUrl; link.download = download.filename;
        document.body.append(link); link.click();
      } finally {
        link.remove(); window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      }
    },
    probeDocumentMedia: (...args) => probeDocumentMedia(...args),
    get roomStateAccessToken() { return context.roomStateAccessToken; },
    get roomDocuments() { return context.roomDocuments; }, set roomDocuments(value) { context.roomDocuments = value; },
    get selectedDocumentId() { return context.selectedDocumentId; },
    set selectedDocumentId(value) {
      context.selectedDocumentId = value;
      if (value) localStorage.setItem(`vrata.documents.selected.${roomId}`, value);
      else localStorage.removeItem(`vrata.documents.selected.${roomId}`);
    },
    get documentsLoading() { return documentsLoading; }, set documentsLoading(value) {
      if (documentsLoading && !value) libraryLoadAttempted = true;
      documentsLoading = value;
    },
    get documentUploadInFlight() { return documentUploadInFlight; }, set documentUploadInFlight(value) { documentUploadInFlight = value; },
    documentOperationsInFlight,
    get uploadPolicy() { return uploadPolicy; }, set uploadPolicy(value) { uploadPolicy = value; libraryObserved = true; }
  });

  return {
    canViewDocuments,
    canUploadDocuments,
    canPresentDocuments,
    selectedDocument,
    documentErrorCode,
    setDocumentStatus,
    renderDocumentsUi,
    loadRoomDocuments: actions.loadRoomDocuments,
    uploadSelectedDocument: actions.uploadSelectedDocument,
    invalidate: actions.invalidate,
    clearFeedback: () => documentFeedback.clear(),
    downloadSelectedDocument: actions.downloadSelectedDocument,
    deleteSelectedDocument: actions.deleteSelectedDocument,
    onPageHide() { actions.invalidate(); documentFeedback.clear(); renderDocumentsUi(); },
    async onPageShow(event: Pick<PageTransitionEvent, "persisted">) { if (event.persisted && canViewDocuments()) await actions.loadRoomDocuments(); }
  };
}
