import { hasRoomPermission } from "@vrata/shared-types";
import type * as RuntimeApi from "./index.js";
import type { RuntimeDocumentRecord } from "./index.js";
import type { probeDocumentMedia } from "./document-media-probe.js";
import type { createRuntimeDebugState } from "./runtime-debug-state.js";
import { createDocumentFeedback } from "./document-feedback.js";
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
  documentsPanelEl: Pick<HTMLElement, "hidden">;
  documentUploadInput: Pick<HTMLInputElement, "disabled" | "value"> & { files: ArrayLike<File> | null };
  documentUploadButton: Pick<HTMLButtonElement, "disabled">;
  documentSelect: Pick<HTMLSelectElement, "disabled" | "replaceChildren">;
  documentDownloadButton: Pick<HTMLButtonElement, "disabled">;
  documentSurfaceButton: Pick<HTMLButtonElement, "disabled">;
  documentDeleteButton: Pick<HTMLButtonElement, "disabled">;
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
    documentUploadButton, documentSelect, documentDownloadButton,
    documentSurfaceButton, documentDeleteButton, documentStatusEl,
    renderPresentationControls, renderDocumentMediaControls,
    listRoomDocuments, uploadRoomDocument, downloadRoomDocument,
    deleteRoomDocument, probeDocumentMedia
  } = context;

  let documentsLoading = false;
  let documentUploadInFlight = false;
  const documentFeedback = createDocumentFeedback();

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
    const message = error instanceof Error ? error.message : String(error);
    return message.split(":").slice(0, 3).join(":") || "document_error";
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
    if (message !== undefined) documentFeedback.keepOrSet(message);
    const visible = canViewDocuments();
    documentsPanelEl.hidden = !visible;
    if (!visible) {
      documentUploadInput.disabled = true;
      documentUploadButton.disabled = true;
      documentSelect.disabled = true;
      documentDownloadButton.disabled = true;
      documentSurfaceButton.disabled = true;
      documentDeleteButton.disabled = true;
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
    documentDownloadButton.disabled = !selected || !canDownloadDocuments() || documentsLoading;
    documentSurfaceButton.disabled = !selected || !["pdf", "image", "video"].includes(selected.metadata?.kind ?? "") || !canPresentDocuments() || documentsLoading || context.presentationActionInFlight;
    documentDeleteButton.disabled = !selected || !canDeleteDocuments() || documentsLoading;
    renderDocumentStatus();
    renderPresentationControls();
    renderDocumentMediaControls();
  }

  const actions = createDocumentLibraryActions({
    apiBaseUrl, roomId, canViewDocuments, canUploadDocuments,
    selectedFile: () => documentUploadInput.files?.[0], clearFile: () => { documentUploadInput.value = ""; },
    setDocumentStatus, renderDocumentsUi,
    listRoomDocuments: (...args) => listRoomDocuments(...args),
    uploadRoomDocument: (...args) => uploadRoomDocument(...args),
    probeDocumentMedia: (...args) => probeDocumentMedia(...args),
    get roomStateAccessToken() { return context.roomStateAccessToken; },
    get roomDocuments() { return context.roomDocuments; }, set roomDocuments(value) { context.roomDocuments = value; },
    get selectedDocumentId() { return context.selectedDocumentId; },
    set selectedDocumentId(value) {
      context.selectedDocumentId = value;
      if (value) localStorage.setItem(`vrata.documents.selected.${roomId}`, value);
      else localStorage.removeItem(`vrata.documents.selected.${roomId}`);
    },
    get documentsLoading() { return documentsLoading; }, set documentsLoading(value) { documentsLoading = value; },
    get documentUploadInFlight() { return documentUploadInFlight; }, set documentUploadInFlight(value) { documentUploadInFlight = value; }
  });

  async function downloadSelectedDocument(): Promise<void> {
    const selected = selectedDocument();
    if (!selected) return;
    try {
      setDocumentStatus("Downloading document...");
      const download = await downloadRoomDocument(apiBaseUrl, selected, context.roomStateAccessToken);
      const objectUrl = URL.createObjectURL(download.blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = download.filename;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setDocumentStatus(`Document downloaded: ${download.filename}`);
    } catch (error) {
      console.warn("document_download_failed", error);
      setDocumentStatus(`Document download failed: ${documentErrorCode(error)}`, documentErrorCode(error));
    }
  }

  async function deleteSelectedDocument(): Promise<void> {
    const selected = selectedDocument();
    if (!selected) return;
    try {
      setDocumentStatus("Deleting document...");
      await deleteRoomDocument(apiBaseUrl, roomId, selected.documentId, context.roomStateAccessToken);
      context.roomDocuments = context.roomDocuments.filter((item) => item.documentId !== selected.documentId);
      context.selectedDocumentId = context.roomDocuments[0]?.documentId ?? "";
      if (context.selectedDocumentId) {
        localStorage.setItem(`vrata.documents.selected.${roomId}`, context.selectedDocumentId);
      } else {
        localStorage.removeItem(`vrata.documents.selected.${roomId}`);
      }
      renderDocumentsUi(`Document deleted: ${selected.filename}`);
    } catch (error) {
      console.warn("document_delete_failed", error);
      setDocumentStatus(`Document delete failed: ${documentErrorCode(error)}`, documentErrorCode(error));
    }
  }

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
    downloadSelectedDocument,
    deleteSelectedDocument
  };
}
