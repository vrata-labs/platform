import { DocumentActionError, DocumentUploadError, documentActionFailure, documentUploadFailure, type DocumentOperation } from "./document-feedback.js";
import type { DocumentUploadPolicy } from "@vrata/shared-types";
import { validateDocumentUpload } from "./document-upload-policy.js";
import type * as RuntimeApi from "./index.js";
import type { probeDocumentMedia } from "./document-media-probe.js";

export interface DocumentLibraryContext {
  apiBaseUrl: string;
  roomId: string;
  readonly roomStateAccessToken: string;
  roomDocuments: RuntimeApi.RuntimeDocumentRecord[];
  selectedDocumentId: string;
  documentsLoading: boolean;
  documentUploadInFlight: boolean;
  documentOperationsInFlight: Record<DocumentOperation, boolean>;
  uploadPolicy: DocumentUploadPolicy | null;
  canViewDocuments(): boolean;
  canUploadDocuments(): boolean;
  canDownloadDocuments(): boolean;
  canDeleteDocuments(): boolean;
  selectedDocument(): RuntimeApi.RuntimeDocumentRecord | null;
  saveDownload(download: { blob: Blob; filename: string }): void;
  selectedFile(): File | undefined;
  clearFile(): void;
  setDocumentStatus(message: string, errorCode?: string | null): void;
  renderDocumentsUi(): void;
  listRoomDocuments: typeof RuntimeApi.listRoomDocuments;
  uploadRoomDocument: typeof RuntimeApi.uploadRoomDocument;
  downloadRoomDocument: typeof RuntimeApi.downloadRoomDocument;
  deleteRoomDocument: typeof RuntimeApi.deleteRoomDocument;
  probeDocumentMedia: typeof probeDocumentMedia;
}

export function createDocumentLibraryActions(context: DocumentLibraryContext, uploadTimeoutMs = 60_000) {
  let generation = 0;
  let listRevision = 0;
  let mutationRevision = 0;
  let uploadController: AbortController | null = null;
  let uploadRequestStarted = false;
  const operationControllers = new Map<DocumentOperation, AbortController>();
  let queuedRefresh: { generation: number; retry: 0 | 1 } | null = null;

  function requestAuthoritativeRefresh(retry: 0 | 1 = 1): void {
    if (queuedRefresh?.generation === generation) { queuedRefresh.retry = Math.max(queuedRefresh.retry, retry) as 0 | 1; return; }
    const queued = { generation, retry }; queuedRefresh = queued;
    queueMicrotask(() => {
      if (queuedRefresh !== queued) return;
      queuedRefresh = null;
      if (generation === queued.generation && context.canViewDocuments()) void loadRoomDocuments({ preserveFeedback: true, retryOnMutation: queued.retry });
    });
  }

  async function loadRoomDocuments(options: { preserveFeedback?: boolean; retryOnMutation?: 0 | 1 } = {}): Promise<void> {
    if (!context.canViewDocuments()) { context.renderDocumentsUi(); return; }
    context.renderDocumentsUi();
    const currentGeneration = generation;
    const revision = ++listRevision;
    const mutation = mutationRevision;
    const current = () => generation === currentGeneration && revision === listRevision;
    context.documentsLoading = true;
    context.renderDocumentsUi();
    try {
      const library = await context.listRoomDocuments(context.apiBaseUrl, context.roomId, context.roomStateAccessToken);
      if (!current() || !context.canViewDocuments()) return;
      context.uploadPolicy = library.uploadPolicy;
      if (mutation !== mutationRevision) { if (options.retryOnMutation === 1) requestAuthoritativeRefresh(0); return; }
      const documents = library.items;
      context.roomDocuments = documents;
      if (context.selectedDocumentId && !documents.some(item => item.documentId === context.selectedDocumentId)) {
        context.selectedDocumentId = "";
      }
      if (!options.preserveFeedback) context.setDocumentStatus(documents.length ? `Documents ready: ${documents.length}` : "No room documents yet");
    } catch {
      if (!options.preserveFeedback && current() && mutation === mutationRevision && context.canViewDocuments()) context.setDocumentStatus("Documents unavailable", "documents_unavailable");
    } finally {
      if (current()) { context.documentsLoading = false; context.renderDocumentsUi(); }
    }
  }

  async function uploadSelectedDocument(): Promise<void> {
    if (context.documentUploadInFlight) return;
    const file = context.selectedFile();
    if (!file) { context.setDocumentStatus("Choose a document first"); return; }
    if (!context.canUploadDocuments()) { context.setDocumentStatus("Document upload permission required", "document_permission_denied"); return; }
    try { validateDocumentUpload(file, context.uploadPolicy); }
    catch (error) { const feedback = documentUploadFailure(error); context.setDocumentStatus(feedback.message, feedback.errorCode); return; }
    context.renderDocumentsUi();
    const currentGeneration = generation;
    const controller = new AbortController();
    uploadController = controller;
    uploadRequestStarted = false;
    const current = () => generation === currentGeneration && uploadController === controller && context.canUploadDocuments();
    context.documentUploadInFlight = true;
    context.renderDocumentsUi();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let rejectAborted!: (reason: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
    const onAbort = () => rejectAborted(new DocumentUploadError(0, "document_upload_timeout"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => controller.abort(), uploadTimeoutMs);
    try {
      const work = async () => {
        const media = await context.probeDocumentMedia(file);
        if (controller.signal.aborted || !current()) return null;
        uploadRequestStarted = true;
        return context.uploadRoomDocument(context.apiBaseUrl, context.roomId, context.roomStateAccessToken, file, media ?? undefined, controller.signal);
      };
      const document = await Promise.race([work(), aborted]);
      if (!document || !current()) return;
      mutationRevision++;
      context.roomDocuments = [document, ...context.roomDocuments.filter(item => item.documentId !== document.documentId)];
      context.selectedDocumentId = document.documentId;
      context.clearFile();
      context.setDocumentStatus(`Document uploaded: ${document.filename}`);
    } catch (error) {
      if (current()) {
        const feedback = documentUploadFailure(uploadRequestStarted && !(error instanceof DocumentUploadError)
          ? new DocumentUploadError(0, "document_upload_unconfirmed") : error);
        context.setDocumentStatus(feedback.message, feedback.errorCode);
        if (uploadRequestStarted && ["document_upload_unconfirmed", "document_upload_timeout"].includes(feedback.errorCode ?? "")) {
          mutationRevision++; requestAuthoritativeRefresh();
        }
      }
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", onAbort);
      if (uploadController === controller) {
        uploadController = null;
        uploadRequestStarted = false;
        context.documentUploadInFlight = false;
        context.renderDocumentsUi();
      }
    }
  }

  async function runDocumentOperation(operation: DocumentOperation): Promise<void> {
    if (context.documentOperationsInFlight[operation]) return;
    const selected = context.selectedDocument();
    if (!selected) return;
    const allowed = () => operation === "download" ? context.canDownloadDocuments() : context.canDeleteDocuments();
    if (!allowed()) {
      const feedback = documentActionFailure(new DocumentActionError(operation, 403), operation);
      context.setDocumentStatus(feedback.message, feedback.errorCode); return;
    }
    context.renderDocumentsUi();
    const currentGeneration = generation, controller = new AbortController();
    operationControllers.set(operation, controller);
    const current = () => generation === currentGeneration && operationControllers.get(operation) === controller && allowed();
    context.documentOperationsInFlight[operation] = true;
    context.setDocumentStatus(operation === "download" ? "Downloading document..." : "Deleting document...");
    context.renderDocumentsUi();
    let rejectAborted!: (reason: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
    const onAbort = () => rejectAborted(new DocumentActionError(operation, 0, `document_${operation}_timeout`));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), uploadTimeoutMs);
    let refreshUnknownDeletion = false;
    try {
      if (operation === "download") {
        const download = await Promise.race([context.downloadRoomDocument(context.apiBaseUrl, selected, context.roomStateAccessToken, controller.signal), aborted]);
        if (!current()) return;
        if (!context.roomDocuments.some(item => item.documentId === selected.documentId)) {
          const feedback = documentActionFailure(new DocumentActionError("download", 404), "download");
          context.setDocumentStatus(feedback.message, feedback.errorCode); return;
        }
        context.saveDownload(download);
        context.setDocumentStatus(`Document downloaded: ${download.filename}`);
      } else {
        await Promise.race([context.deleteRoomDocument(context.apiBaseUrl, context.roomId, selected.documentId, context.roomStateAccessToken, controller.signal), aborted]);
        if (!current()) return;
        mutationRevision++;
        context.roomDocuments = context.roomDocuments.filter(item => item.documentId !== selected.documentId);
        if (!context.roomDocuments.some(item => item.documentId === context.selectedDocumentId)) context.selectedDocumentId = context.roomDocuments[0]?.documentId ?? "";
        context.setDocumentStatus(`Document deleted: ${selected.filename}`);
      }
    } catch (error) {
      if (current()) {
        const feedback = documentActionFailure(error, operation);
        context.setDocumentStatus(feedback.message, feedback.errorCode);
        if (operation === "delete") { mutationRevision++; refreshUnknownDeletion = true; }
      }
    } finally {
      clearTimeout(timeout); controller.signal.removeEventListener("abort", onAbort);
      if (operationControllers.get(operation) === controller) {
        operationControllers.delete(operation); context.documentOperationsInFlight[operation] = false; context.renderDocumentsUi();
      }
      if (refreshUnknownDeletion && generation === currentGeneration) requestAuthoritativeRefresh();
    }
  }

  function revokeOperation(operation: DocumentOperation | "upload"): boolean {
    if (operation === "upload") {
      const controller = uploadController; if (!controller) return false;
      const sent = uploadRequestStarted;
      uploadController = null; uploadRequestStarted = false; context.documentUploadInFlight = false; controller.abort();
      const feedback = documentUploadFailure(new DocumentUploadError(sent ? 0 : 403, sent ? "document_upload_unconfirmed" : "document_permission_denied"));
      context.setDocumentStatus(feedback.message, feedback.errorCode);
      if (sent) { mutationRevision++; requestAuthoritativeRefresh(); }
      return true;
    }
    const controller = operationControllers.get(operation); if (!controller) return false;
    operationControllers.delete(operation); context.documentOperationsInFlight[operation] = false; controller.abort();
    const feedback = documentActionFailure(new DocumentActionError(operation, operation === "download" ? 403 : 0), operation);
    context.setDocumentStatus(feedback.message, feedback.errorCode);
    if (operation === "delete") { mutationRevision++; requestAuthoritativeRefresh(); }
    return true;
  }

  function invalidate(): void {
    generation++;
    queuedRefresh = null;
    uploadController?.abort();
    for (const controller of operationControllers.values()) controller.abort();
    uploadController = null;
    uploadRequestStarted = false;
    operationControllers.clear();
    context.documentUploadInFlight = false;
    context.documentsLoading = false;
    context.documentOperationsInFlight.download = false;
    context.documentOperationsInFlight.delete = false;
  }

  return { loadRoomDocuments, uploadSelectedDocument, invalidate, revokeOperation, generation: () => generation,
    downloadSelectedDocument: () => runDocumentOperation("download"), deleteSelectedDocument: () => runDocumentOperation("delete") };
}
