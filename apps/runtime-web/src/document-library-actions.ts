import { DocumentUploadError, documentUploadFailure } from "./document-feedback.js";
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
  canViewDocuments(): boolean;
  canUploadDocuments(): boolean;
  selectedFile(): File | undefined;
  clearFile(): void;
  setDocumentStatus(message: string, errorCode?: string | null): void;
  renderDocumentsUi(): void;
  listRoomDocuments: typeof RuntimeApi.listRoomDocuments;
  uploadRoomDocument: typeof RuntimeApi.uploadRoomDocument;
  probeDocumentMedia: typeof probeDocumentMedia;
}

export function createDocumentLibraryActions(context: DocumentLibraryContext, uploadTimeoutMs = 60_000) {
  let generation = 0;
  let listRevision = 0;
  let mutationRevision = 0;
  let uploadController: AbortController | null = null;

  async function loadRoomDocuments(): Promise<void> {
    if (!context.canViewDocuments()) { context.renderDocumentsUi(); return; }
    const currentGeneration = generation;
    const revision = ++listRevision;
    const mutation = mutationRevision;
    const current = () => generation === currentGeneration && revision === listRevision;
    context.documentsLoading = true;
    context.renderDocumentsUi();
    try {
      const documents = await context.listRoomDocuments(context.apiBaseUrl, context.roomId, context.roomStateAccessToken);
      if (!current() || mutation !== mutationRevision || !context.canViewDocuments()) return;
      context.roomDocuments = documents;
      if (context.selectedDocumentId && !documents.some(item => item.documentId === context.selectedDocumentId)) {
        context.selectedDocumentId = "";
      }
      context.setDocumentStatus(documents.length ? `Documents ready: ${documents.length}` : "No room documents yet");
    } catch {
      if (current() && mutation === mutationRevision && context.canViewDocuments()) context.setDocumentStatus("Documents unavailable", "documents_unavailable");
    } finally {
      if (current()) { context.documentsLoading = false; context.renderDocumentsUi(); }
    }
  }

  async function uploadSelectedDocument(): Promise<void> {
    if (context.documentUploadInFlight) return;
    const file = context.selectedFile();
    if (!file) { context.setDocumentStatus("Choose a document first"); return; }
    if (!context.canUploadDocuments()) { context.setDocumentStatus("Document upload permission required", "document_permission_denied"); return; }
    const currentGeneration = generation;
    const controller = new AbortController();
    uploadController = controller;
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
        const feedback = documentUploadFailure(error);
        context.setDocumentStatus(feedback.message, feedback.errorCode);
      }
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", onAbort);
      if (uploadController === controller) {
        uploadController = null;
        context.documentUploadInFlight = false;
        context.renderDocumentsUi();
      }
    }
  }

  function invalidate(): void {
    generation++;
    uploadController?.abort();
    uploadController = null;
    context.documentUploadInFlight = false;
    context.documentsLoading = false;
  }

  return { loadRoomDocuments, uploadSelectedDocument, invalidate };
}
