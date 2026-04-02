import { serializeCompactPoseFrame, serializeReliableAvatarState } from "./avatar-snapshot-codec.js";
import type { AvatarReliableState, CompactPoseFrame, LocalAvatarSnapshotV1 } from "./avatar-types.js";

export interface AvatarOutboundPayload {
  reliableState: AvatarReliableState;
  poseFrame: CompactPoseFrame;
}

export interface AvatarOutboundPublisher {
  build(input: {
    participantId: string;
    snapshot: LocalAvatarSnapshotV1;
    muted: boolean;
    audioActive: boolean;
    seated?: boolean;
    seatId?: string;
    sentAtMs?: number;
  }): AvatarOutboundPayload;
}

export function createAvatarOutboundPublisher(initialSeq = 0): AvatarOutboundPublisher {
  let seq = initialSeq;

  return {
    build(input): AvatarOutboundPayload {
      seq += 1;
      const sentAtMs = input.sentAtMs ?? Date.now();
      return {
        reliableState: serializeReliableAvatarState({
          participantId: input.participantId,
          snapshot: input.snapshot,
          muted: input.muted,
          audioActive: input.audioActive,
          seated: input.seated,
          seatId: input.seatId
        }),
        poseFrame: serializeCompactPoseFrame({
          seq,
          sentAtMs,
          snapshot: input.snapshot
        })
      };
    }
  };
}
