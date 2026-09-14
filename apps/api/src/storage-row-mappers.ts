import type {
  RoomDocumentMetadata,
  RoomDocumentRecord,
  RoomInviteRecord,
  RoomNoteRecord,
  RoomNoteScope,
  RoomNoteVersionAction,
  RoomNoteVersionRecord,
  WaitingRoomRequestRecord
} from "./storage-contracts.js";

export function isoString(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export function mapRoomInviteRow(row: {
  invite_id: string;
  room_id: string;
  token_hash: string;
  role: RoomInviteRecord["role"];
  waiting_room_enabled: boolean;
  created_at: string | Date;
  expires_at: string | Date;
  revoked_at?: string | Date | null;
  created_by?: string | null;
  revoked_by?: string | null;
}): RoomInviteRecord {
  return {
    inviteId: row.invite_id,
    roomId: row.room_id,
    tokenHash: row.token_hash,
    role: row.role,
    waitingRoomEnabled: row.waiting_room_enabled,
    createdAt: isoString(row.created_at) ?? new Date().toISOString(),
    expiresAt: isoString(row.expires_at) ?? new Date().toISOString(),
    revokedAt: isoString(row.revoked_at),
    createdBy: row.created_by ?? null,
    revokedBy: row.revoked_by ?? null
  };
}

export function mapWaitingRoomRequestRow(row: {
  request_id: string;
  room_id: string;
  invite_id: string;
  participant_id: string;
  display_name: string;
  status: WaitingRoomRequestRecord["status"];
  created_at: string | Date;
  decided_at?: string | Date | null;
  decided_by?: string | null;
}): WaitingRoomRequestRecord {
  return {
    requestId: row.request_id,
    roomId: row.room_id,
    inviteId: row.invite_id,
    participantId: row.participant_id,
    displayName: row.display_name,
    status: row.status,
    createdAt: isoString(row.created_at) ?? new Date().toISOString(),
    decidedAt: isoString(row.decided_at),
    decidedBy: row.decided_by ?? null
  };
}

export function mapRoomNoteRow(row: {
  note_id: string;
  room_id: string;
  scope: RoomNoteScope;
  owner_participant_id?: string | null;
  content: string;
  updated_at: string | Date;
  updated_by?: string | null;
  deleted_at?: string | Date | null;
  deleted_by?: string | null;
}): RoomNoteRecord {
  return {
    noteId: row.note_id,
    roomId: row.room_id,
    scope: row.scope,
    ownerParticipantId: row.owner_participant_id ?? null,
    content: row.content,
    updatedAt: isoString(row.updated_at) ?? new Date().toISOString(),
    updatedBy: row.updated_by ?? null,
    deletedAt: isoString(row.deleted_at),
    deletedBy: row.deleted_by ?? null
  };
}

export function mapRoomNoteVersionRow(row: {
  version_id: string;
  note_id: string;
  room_id: string;
  scope: RoomNoteScope;
  owner_participant_id?: string | null;
  content: string;
  action: RoomNoteVersionAction;
  restored_from_version_id?: string | null;
  created_at: string | Date;
  created_by?: string | null;
}): RoomNoteVersionRecord {
  return {
    versionId: row.version_id,
    noteId: row.note_id,
    roomId: row.room_id,
    scope: row.scope,
    ownerParticipantId: row.owner_participant_id ?? null,
    content: row.content,
    action: row.action,
    restoredFromVersionId: row.restored_from_version_id ?? null,
    createdAt: isoString(row.created_at) ?? new Date().toISOString(),
    createdBy: row.created_by ?? null
  };
}

export function mapRoomDocumentRow(row: {
  document_id: string;
  room_id: string;
  tenant_id: string;
  filename: string;
  content_type: string;
  size_bytes: string | number;
  storage_key: string;
  checksum: string;
  uploaded_by?: string | null;
  uploaded_at: string | Date;
  deleted_at?: string | Date | null;
  deleted_by?: string | null;
  linked_surface_id?: string | null;
  metadata?: RoomDocumentMetadata | null;
}): RoomDocumentRecord {
  return {
    documentId: row.document_id,
    roomId: row.room_id,
    tenantId: row.tenant_id,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    storageKey: row.storage_key,
    checksum: row.checksum,
    metadata: row.metadata ?? {},
    uploadedBy: row.uploaded_by ?? null,
    uploadedAt: isoString(row.uploaded_at) ?? new Date().toISOString(),
    deletedAt: isoString(row.deleted_at),
    deletedBy: row.deleted_by ?? null,
    linkedSurfaceId: row.linked_surface_id ?? null
  };
}
