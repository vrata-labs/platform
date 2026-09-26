export interface DocumentFeedback {
  message: string;
  errorCode: string | null;
}

// Only allowlisted codes cross the API/UI boundary. Server errors may contain
// storage details; neither those details nor arbitrary reasons belong in the HUD.
const uploadMessages = {
  unsupported_document_mime: "Unsupported file format. Use PDF, PNG, JPEG, WebP, MP4, WebM, or TXT.",
  invalid_document_filename: "Invalid filename. Rename the file and try again.",
  document_too_large: "The file exceeds the server upload limit. Choose a smaller file.",
  corrupt_pdf: "This PDF cannot be read. Export it again and retry.",
  encrypted_pdf_unsupported: "Password-protected PDFs are not supported. Upload an unprotected copy.",
  pdf_page_limit_exceeded: "This PDF has too many pages. Split it into smaller documents.",
  document_permission_denied: "Upload permission is unavailable. Ask the host to grant presenting access.",
  document_storage_unavailable: "Document storage is unavailable. Please try again later.",
  document_upload_timeout: "Upload timed out. Check the document list before retrying.",
  media_decode_failed: "This image or video cannot be read. Export it again and retry.",
  media_probe_timeout: "Checking this media file timed out. Try another file.",
  unsupported_video_codec: "This browser cannot play the selected video format.",
  video_duration_invalid: "The video duration could not be read. Export it again and retry.",
  invalid_image_signature: "The image contents do not match its file format. Export it again and retry.",
  invalid_video_container: "The video contents do not match its file format. Export it again and retry.",
  video_metadata_missing: "The video metadata could not be read. Export it again and retry.",
  invalid_media_dimensions: "The media dimensions are invalid. Export it again and retry.",
  document_upload_failed: "Document upload failed. Check your connection and try again."
} as const;

export type DocumentUploadErrorCode = keyof typeof uploadMessages;

export class DocumentUploadError extends Error {
  readonly code: DocumentUploadErrorCode;

  constructor(status: number, code?: unknown) {
    const safeCode: DocumentUploadErrorCode = status === 401 || status === 403 ? "document_permission_denied"
      : status === 413 ? "document_too_large"
      : status === 503 ? "document_storage_unavailable"
      : typeof code === "string" && Object.hasOwn(uploadMessages, code) ? code as DocumentUploadErrorCode
      : "document_upload_failed";
    super(safeCode);
    this.name = "DocumentUploadError";
    this.code = safeCode;
  }
}

export function documentUploadFailure(error: unknown): DocumentFeedback {
  const code = error instanceof DocumentUploadError ? error.code
    : error instanceof Error && Object.hasOwn(uploadMessages, error.message) ? error.message as DocumentUploadErrorCode
    : "document_upload_failed";
  return { message: uploadMessages[code], errorCode: code };
}

export function createDocumentFeedback() {
  let notification: DocumentFeedback | null = null;
  return {
    set(message: string, errorCode: string | null = null) {
      notification = { message, errorCode };
    },
    // Existing surface actions re-render with the current message in finally.
    // That must not turn an error into a successful status with the same text.
    keepOrSet(message: string) {
      if (message === "Uploading document..." || message === "Documents loading...") return;
      if (message !== notification?.message) notification = { message, errorCode: null };
    },
    clear() { notification = null; },
    read(input: { visible: boolean; enabled: boolean; uploading: boolean; loading: boolean; count: number }): DocumentFeedback {
      if (!input.visible) return { message: input.enabled ? "Documents permission required" : "Documents disabled", errorCode: null };
      if (input.uploading) return { message: "Uploading document...", errorCode: null };
      if (input.loading) return { message: "Documents loading...", errorCode: null };
      return notification ?? { message: input.count ? `Documents ready: ${input.count}` : "No room documents yet", errorCode: null };
    }
  };
}
