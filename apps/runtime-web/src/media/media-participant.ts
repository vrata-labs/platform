import { verifyUserMediaIdentity, type UserMediaScope } from "@vrata/shared-types";
import type { RemoteParticipant, Track } from "livekit-client";

export interface MediaPeer {
  readonly identity: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly kind: number;
}
export type MediaPeerBinding =
  | { kind: "user"; participantId: string; scope: UserMediaScope | null; mediaIdentity: string; epoch?: number }
  | { kind: "executor"; mediaIdentity: string };

/** A verified mapping is scoped to this SDK peer object, room and immutable attribute snapshot. */
export function createMediaParticipantResolver(onReady: () => void) {
  const cache = new WeakMap<object, { fingerprint: string; binding: MediaPeerBinding | null }>();
  return (peer: MediaPeer | null | undefined, room: string, protocol: 2 | null): MediaPeerBinding | null => {
    if (!peer) return null;
    if (protocol !== 2) return { kind: "user", participantId: peer.identity, scope: null, mediaIdentity: peer.identity };
    if (peer.identity.startsWith("remote-browser:")) return { kind: "executor", mediaIdentity: peer.identity };
    if (peer.kind !== 0 || !/^vmi[23]\./.test(peer.identity)) return null;
    const identity = peer.identity, attributes = { ...peer.attributes };
    const fingerprint = JSON.stringify([room, identity, Object.entries(attributes).sort(([a], [b]) => a.localeCompare(b))]);
    const previous = cache.get(peer);
    if (previous?.fingerprint === fingerprint) return previous.binding;
    const entry = { fingerprint, binding: null as MediaPeerBinding | null };
    cache.set(peer, entry);
    void verifyUserMediaIdentity(room, identity, attributes).then(binding => {
      if (cache.get(peer) !== entry || !binding) return;
      entry.binding = { kind: "user", ...binding, mediaIdentity: identity };
      onReady();
    }).catch(() => undefined);
    return null;
  };
}

export interface MicrophoneCandidate<T> {
  participantId: string;
  mediaIdentity: string;
  trackKey: string;
  scope: UserMediaScope | null;
  /** Codec-3 lineage; a newer epoch is the recovered connection the server keeps. */
  epoch?: number;
  value: T;
}

/** One audible source per domain participant, regardless of how many scope classes are connected.
 * Until the server evicts a pre-recovery lineage, the newer epoch is heard; this is a UI aid, not enforcement. */
export function selectRemoteMicrophones<T>(candidates: Iterable<MicrophoneCandidate<T>>, localParticipantId: string,
  activeParticipantIds: ReadonlySet<string>): Map<string, MicrophoneCandidate<T>> {
  const selected = new Map<string, MicrophoneCandidate<T>>();
  for (const candidate of candidates) {
    if (candidate.participantId === localParticipantId || !activeParticipantIds.has(candidate.participantId) || candidate.scope === "s") continue;
    const previous = selected.get(candidate.participantId);
    const rank = (scope: UserMediaScope | null) => scope === "ms" ? 2 : 1;
    const epoch = (value: MicrophoneCandidate<T>) => value.epoch ?? 0;
    if (!previous || epoch(candidate) > epoch(previous) || epoch(candidate) === epoch(previous) && (rank(candidate.scope) > rank(previous.scope)
      || rank(candidate.scope) === rank(previous.scope) && candidate.mediaIdentity < previous.mediaIdentity)) {
      selected.set(candidate.participantId, candidate);
    }
  }
  return selected;
}

export function sameMicrophoneOwner(left: { mediaIdentity: string; trackKey: string; track: object }, right: { mediaIdentity: string; trackKey: string; track: object }): boolean {
  return left.mediaIdentity === right.mediaIdentity && left.trackKey === right.trackKey && left.track === right.track;
}

export function planRemoteMicrophones(peers: Iterable<RemoteParticipant>, resolvePeer: (peer: MediaPeer) => MediaPeerBinding | null,
  localParticipantId: string, activeParticipantIds: ReadonlySet<string>, excludedTrack?: Track) {
  const candidates: Array<MicrophoneCandidate<{ participant: RemoteParticipant; track: Track }>> = [];
  for (const participant of peers) {
    const binding = resolvePeer(participant);
    if (binding?.kind !== "user" || binding.scope === "s") continue;
    for (const publication of participant.trackPublications.values()) {
      const track = publication.track;
      if (!track || track === excludedTrack || track.kind !== "audio" || publication.isMuted || publication.source === "screen_share_audio") continue;
      if (binding.scope !== null && publication.source !== "microphone") continue;
      candidates.push({ participantId: binding.participantId, mediaIdentity: binding.mediaIdentity, scope: binding.scope,
        ...(binding.epoch === undefined ? {} : { epoch: binding.epoch }), trackKey: publication.trackSid, value: { participant, track } });
      break;
    }
  }
  return selectRemoteMicrophones(candidates, localParticipantId, activeParticipantIds);
}
