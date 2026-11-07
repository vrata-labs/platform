import { resolveLocalSeatRootPosition } from "../../apps/runtime-web/src/local/seat-pose.ts";
import type { SceneBundleSeatAnchor } from "../../apps/runtime-web/src/scene-bundle.js";
import type { RoomAuthorityCapture } from "./room-state-observation";

export interface OwnSeatClient {
  participantId: string;
  currentSeatId: string | null;
  occupantId: string | null;
  roomStateConnected: boolean;
  root: { x: number; y: number; z: number };
}
type AuthoritySnapshot = ReturnType<RoomAuthorityCapture["snapshot"]>;

/** Only the selected seat and own participant leave the passive capture. No raw frames. */
export function ownSeatProof(client: OwnSeatClient, server: AuthoritySnapshot,
  seat: SceneBundleSeatAnchor, beforeClaim: { generation: number; sequence: number }) {
  return {
    seatId: seat.id, client, expectedRoot: resolveLocalSeatRootPosition(seat, false), beforeClaim,
    server: server ? { socketScope: server.socketScope, generation: server.generation, sequence: server.sequence,
      occupantId: server.occupancy[seat.id] ?? null,
      ownParticipantId: server.participants.find(id => id === client.participantId) ?? null } : null
  };
}

export function isOwnSeatProof(proof: ReturnType<typeof ownSeatProof>) {
  const { client, server, seatId, expectedRoot, beforeClaim } = proof;
  return Boolean(server && client.roomStateConnected && client.participantId
    && client.currentSeatId === seatId && client.occupantId === client.participantId
    && server.occupantId === client.participantId && server.ownParticipantId === client.participantId
    && (server.generation > beforeClaim.generation
      || (server.generation === beforeClaim.generation && server.sequence > beforeClaim.sequence))
    && ["x", "y", "z"].every(axis => {
      const key = axis as keyof typeof expectedRoot;
      return Number.isFinite(client.root[key]) && Math.abs(client.root[key] - expectedRoot[key]) <= 0.002;
    }));
}
