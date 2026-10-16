import { TrackSource, type ParticipantInfo, type ParticipantPermission } from "livekit-server-sdk";
import { verifyUserMediaIdentity, type UserMediaBinding, type UserMediaScope } from "@vrata/shared-types";
import type { RoomScreenSourceAuthority } from "./identity/contracts.js";

/** Null is confirmed missing metadata, not an authority-read error. Disable is reversible. */
export function mustEvictUserMedia(authority: RoomScreenSourceAuthority | null, participantId: string): boolean {
  return !authority?.roomActive || authority.removedParticipantIds?.includes(participantId) === true;
}

/** Codec-2 user grants have a fixed non-source tuple. Never copy a preceding connection's permissions. */
export function screenSourceLowering(scope: UserMediaScope): Partial<ParticipantPermission> | null {
  if (scope === "m") return null;
  return {
    canSubscribe: true, canPublishData: true, canUpdateMetadata: false,
    hidden: false, recorder: false, agent: false, canSubscribeMetrics: false, canManageAgentSession: false,
    canPublish: scope === "ms", canPublishSources: scope === "ms" ? [TrackSource.MICROPHONE] : []
  };
}

/** The immutable identity, not the participant's current source list, supplies its original credential ceiling. */
export async function verifiedSourcePeer(room: string, peer: Pick<ParticipantInfo, "identity" | "attributes" | "kind" | "permission">): Promise<UserMediaBinding | null> {
  if (peer.kind !== 0 || peer.permission?.canUpdateMetadata !== false) return null;
  return verifyUserMediaIdentity(room, peer.identity, peer.attributes);
}

/** An RPC acknowledgement alone is not evidence that the native server has retired a track. */
export function screenSourcesRetired(peer: Pick<ParticipantInfo, "permission" | "tracks">, scope: UserMediaScope): boolean {
  const expected = screenSourceLowering(scope), actual = peer.permission;
  if (!expected || !actual) return false;
  for (const key of ["canSubscribe", "canPublishData", "canUpdateMetadata", "hidden", "recorder", "agent", "canSubscribeMetrics", "canManageAgentSession", "canPublish"] as const) {
    if (actual[key] !== expected[key]) return false;
  }
  if (actual.canPublishSources.join() !== expected.canPublishSources!.join()) return false;
  return peer.tracks.every(track => scope === "ms" && track.source === TrackSource.MICROPHONE);
}
