import { RoomServiceClient } from "livekit-server-sdk";
import type { RoomRecord, RoomSessionControlState, Storage } from "./storage-contracts.js";
import { getLivekitCredentials, getMediaTokenConfigError } from "./livekit-config.js";
import { createMediaScreenReconciler, MEDIA_RECONCILIATION_VERSION, type MediaScreenAuthority, type MediaScreenReconciliationStatus } from "./media-screen-reconciler.js";

/** Both room lifecycle and its publisher identities come from one read-only storage snapshot. */
export async function readMediaScreenAuthority(storage: Storage, roomId: string, participantIds?: readonly string[]): Promise<MediaScreenAuthority> {
  const room = await storage.getRoom(roomId);
  if (!room) return { tenantId: null, authority: null, accessEpoch: null };
  // A portal-managed room has one native room per access epoch; any other epoch is a retired generation.
  return { tenantId: room.tenantId, authority: await storage.roomIdentities.screenSourceAuthority(room, participantIds),
    accessEpoch: room.managed?.accessEpoch ?? null };
}

/** Main-path API lifecycle owner. No HTTP role command awaits a native media RPC. */
export function createMediaScreenService(storagePromise: Promise<Storage>, options: {
  env?: NodeJS.ProcessEnv;
  event?: Parameters<typeof createMediaScreenReconciler>[0]["event"];
} = {}) {
  const env = options.env ?? process.env;
  let native: RoomServiceClient | null = null;
  const reconciler = createMediaScreenReconciler({
    async context() {
      if (getMediaTokenConfigError(env) || !env.LIVEKIT_URL) return null;
      let url: URL;
      try { url = new URL(env.LIVEKIT_URL); } catch { return null; }
      if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
      const { apiKey, apiSecret } = getLivekitCredentials(env);
      if (!apiKey || !apiSecret) return null;
      const storage = await storagePromise;
      if (await storage.identityProtocol.minimum() < 2) return null;
      const boundary = await storage.identityProtocol.mediaBoundary();
      if (!boundary) throw new Error("media_screen_namespace_missing");
      if (!native) {
        // LIVEKIT_API_URL reaches the LiveKit HTTP API directly where the public URL serves only signaling.
        native = new RoomServiceClient(env.LIVEKIT_API_URL?.trim() || env.LIVEKIT_URL, apiKey, apiSecret, { requestTimeout: 2 });
      }
      return { ...boundary, prefix: env.LIVEKIT_ROOM_PREFIX ?? "vrata-", native };
    },
    authority: async (roomId, participantIds) => readMediaScreenAuthority(await storagePromise, roomId, participantIds),
    event: options.event
  });
  return {
    start: reconciler.start,
    stop: reconciler.stop,
    async status(roomId: string, expectedRevision: number): Promise<MediaScreenReconciliationStatus> {
      try {
        const storage = await storagePromise;
        const desired = await readMediaScreenAuthority(storage, roomId), boundary = await storage.identityProtocol.mediaBoundary();
        const status = reconciler.status(roomId, desired, boundary);
        return status.desiredVersion.authorityRevision === expectedRevision ? status
          : { ...status, state: status.state === "unavailable" ? "unavailable" : "pending", observedAtMs: null, nativeRoom: "unknown" };
      } catch {
        return { enforcementVersion: MEDIA_RECONCILIATION_VERSION,
          state: "unavailable", desiredVersion: { authorityRevision: expectedRevision, roomActive: null },
          observedAtMs: null, nativeRoom: "unknown" };
      }
    },
    committed(room: RoomRecord, revision: number, state: RoomSessionControlState): MediaScreenReconciliationStatus {
      reconciler.invalidate(room.roomId);
      return { enforcementVersion: MEDIA_RECONCILIATION_VERSION,
        state: "pending", desiredVersion: { authorityRevision: revision,
        roomActive: room.status !== "disabled" && !room.disabledAt && !state.endedAt }, observedAtMs: null, nativeRoom: "unknown" };
    }
  };
}
