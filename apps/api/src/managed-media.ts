import { RoomServiceClient } from "livekit-server-sdk";

import { getLivekitCredentials, getMediaTokenConfigError } from "./livekit-config.js";

export interface ManagedMediaControl {
  /** Creates the room if it does not exist; LiveKit runs with auto_create:false on portal targets. */
  ensureRoom(name: string, options: { maxParticipants?: number | null }): Promise<void>;
  /** Ends every connection of the room; a missing room counts as deleted. */
  deleteRoom(name: string): Promise<void>;
  /** Names of the rooms LiveKit has now. */
  listRooms(): Promise<string[]>;
}

const EMPTY_TIMEOUT_SECONDS = 300;
const DEPARTURE_TIMEOUT_SECONDS = 20;

function isNotFound(error: unknown): boolean {
  const candidate = error as { status?: unknown; code?: unknown } | null;
  return candidate?.status === 404 || candidate?.code === "not_found";
}

// LIVEKIT_API_URL is the server-side address of the LiveKit HTTP API (for example http://livekit:7880 inside
// compose); the public LIVEKIT_URL of a portal target exposes only signaling to browsers.
export function createManagedMediaControl(env: NodeJS.ProcessEnv = process.env): ManagedMediaControl | null {
  if (getMediaTokenConfigError(env)) return null;
  const url = env.LIVEKIT_API_URL?.trim() || env.LIVEKIT_URL?.trim();
  if (!url) return null;
  const { apiKey, apiSecret } = getLivekitCredentials(env);
  if (!apiKey || !apiSecret) return null;
  const client = new RoomServiceClient(url, apiKey, apiSecret, { requestTimeout: 5 });
  return {
    async ensureRoom(name, options) {
      await client.createRoom({
        name,
        emptyTimeout: EMPTY_TIMEOUT_SECONDS,
        departureTimeout: DEPARTURE_TIMEOUT_SECONDS,
        ...(options.maxParticipants ? { maxParticipants: options.maxParticipants } : {})
      });
    },
    async deleteRoom(name) {
      try {
        await client.deleteRoom(name);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
    async listRooms() {
      return (await client.listRooms()).map(room => room.name);
    }
  };
}
