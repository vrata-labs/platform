import type { FreshAudioObservation } from "./fresh-audio-observation";

type AudioSample = { timestamp: number; bytes: number; packets: number; samples: number; energy: number };
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const connected = (peer: FreshAudioObservation["peers"][number]) => !peer.statsFailed
  && (peer.connectionState === "connected" || peer.iceConnectionState === "connected" || peer.iceConnectionState === "completed");

function inbound(observation: FreshAudioObservation | null): Map<string, AudioSample> {
  const result = new Map<string, AudioSample>();
  if (!observation) return result;
  for (const peer of observation.peers) {
    if (!connected(peer)) continue;
    for (const audio of peer.audio) {
      if (audio.direction !== "inbound") continue;
      const timestamp = number(audio.timestamp), bytes = number(audio.bytesReceived), packets = number(audio.packetsReceived);
      const samples = number(audio.totalSamplesReceived), energy = number(audio.totalAudioEnergy), packetTime = number(audio.lastPacketReceivedTimestamp);
      if (timestamp === null || bytes === null || packets === null || samples === null || energy === null || packetTime === null) continue;
      const packetAge = observation.sampledAtMs - packetTime;
      if (packetAge < -1000 || packetAge > 5000) continue;
      result.set(`${peer.peer}:${audio.stream}`, { timestamp, bytes, packets, samples, energy });
    }
  }
  return result;
}

/** Fresh audio RTP and decoded signal, never cached candidate-pair/data-channel bytes. */
export function hasLiveAudio(observation: FreshAudioObservation | null): boolean {
  const receiving = [...inbound(observation).values()].some(audio => audio.bytes > 0 && audio.packets > 0 && audio.samples > 0 && audio.energy > 0);
  const sending = observation?.peers.some(peer => connected(peer) && peer.audio.some(audio => audio.direction === "outbound"
    && (number(audio.bytesSent) ?? 0) > 0 && (number(audio.packetsSent) ?? 0) > 0)) ?? false;
  return receiving && sending;
}

/** Replacement connections/streams establish their own baseline before they can prove progress. */
export function createAudioProgressTracker(initial: FreshAudioObservation | null) {
  const baselines = inbound(initial);
  return (current: FreshAudioObservation | null): boolean => {
    for (const [key, audio] of inbound(current)) {
      const before = baselines.get(key);
      if (!before || audio.timestamp < before.timestamp || audio.bytes < before.bytes || audio.packets < before.packets
        || audio.samples < before.samples || audio.energy < before.energy) {
        baselines.set(key, audio);
        continue;
      }
      if (audio.timestamp > before.timestamp && audio.bytes > before.bytes && audio.packets > before.packets
        && audio.samples > before.samples && audio.energy > before.energy) return true;
    }
    return false;
  };
}
