export function createRoomUrl(baseUrl: string, roomId: string): string {
  return new URL(`/rooms/${roomId}`, baseUrl).toString();
}

export interface TemplateRecord {
  templateId: string;
  label: string;
  assetSlots: string[];
}

export interface RoomCreateInput {
  tenantId: string;
  templateId: string;
  name: string;
  features?: {
    voice?: boolean;
    spatialAudio?: boolean;
    screenShare?: boolean;
  };
}

export interface RoomRecord {
  roomId: string;
  tenantId: string;
  templateId: string;
  name: string;
  roomLink: string;
}

export interface AssetUploadInput {
  tenantId: string;
  kind: string;
  url: string;
}

export async function fetchTemplates(apiBaseUrl: string): Promise<TemplateRecord[]> {
  const response = await fetch(new URL("/api/templates", apiBaseUrl));
  if (!response.ok) {
    throw new Error(`failed_to_fetch_templates:${response.status}`);
  }

  const payload = (await response.json()) as { items: TemplateRecord[] };
  return payload.items;
}

export async function createRoom(apiBaseUrl: string, input: RoomCreateInput): Promise<RoomRecord> {
  const response = await fetch(new URL("/api/rooms", apiBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    throw new Error(`failed_to_create_room:${response.status}`);
  }

  return (await response.json()) as RoomRecord;
}

export async function listRooms(apiBaseUrl: string): Promise<RoomRecord[]> {
  const response = await fetch(new URL("/api/rooms", apiBaseUrl));

  if (!response.ok) {
    throw new Error(`failed_to_list_rooms:${response.status}`);
  }

  const payload = (await response.json()) as { items: RoomRecord[] };
  return payload.items;
}

export async function uploadAsset(apiBaseUrl: string, input: AssetUploadInput): Promise<{ assetId: string }> {
  const response = await fetch(new URL("/api/assets", apiBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    throw new Error(`failed_to_upload_asset:${response.status}`);
  }

  return (await response.json()) as { assetId: string };
}

export interface ControlPlanePageState {
  templates: TemplateRecord[];
  rooms: RoomRecord[];
  roomLink?: string;
  publishStatus: "idle" | "publishing" | "published" | "failed";
}

export function createControlPlanePageState(): ControlPlanePageState {
  return {
    templates: [],
    rooms: [],
    publishStatus: "idle"
  };
}
