import type { BrowserContext, Page } from "@playwright/test";

type FreshAudioObservation = {
  sampledAtMs: number;
  peers: Array<{
    peer: number;
    connectionState: RTCPeerConnectionState;
    iceConnectionState: RTCIceConnectionState;
    statsFailed: boolean;
    audio: Array<Record<string, number | string | null>>;
  }>;
  unavailable?: "not-installed" | "timeout" | "error";
};

/** Passive test observation only: leave constructors, SDP, negotiation and tracks unchanged. */
export async function installFreshAudioObservation(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    if (window !== window.top || !window.RTCPeerConnection) return;
    const root = window as any;
    if (root.__publicDemoFreshAudio) return;
    const peers = new Map<RTCPeerConnection, { id: number; streams: Map<string, number> }>();
    let nextPeer = 0;
    for (const method of ["setLocalDescription", "setRemoteDescription"] as const) {
      const original = RTCPeerConnection.prototype[method];
      RTCPeerConnection.prototype[method] = function (this: RTCPeerConnection, ...args: any[]) {
        if (!peers.has(this)) {
          peers.set(this, { id: ++nextPeer, streams: new Map() });
          const onState = () => {
            if (this.connectionState === "closed") {
              peers.delete(this);
              this.removeEventListener("connectionstatechange", onState);
            }
          };
          this.addEventListener("connectionstatechange", onState);
        }
        return Reflect.apply(original, this, args);
      };
    }
    root.__publicDemoFreshAudio = async () => {
      const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
      const samples = await Promise.all(Array.from(peers, async ([pc, scope]) => {
        if (pc.connectionState === "closed") { peers.delete(pc); return null; }
        const audio: Array<Record<string, unknown>> = [];
        try {
          const report = await pc.getStats();
          report.forEach(record => {
            if (!["inbound-rtp", "outbound-rtp"].includes(record.type) || (record.kind ?? record.mediaType) !== "audio") return;
            if (!scope.streams.has(record.id)) scope.streams.set(record.id, scope.streams.size + 1);
            audio.push({ stream: scope.streams.get(record.id), direction: record.type === "inbound-rtp" ? "inbound" : "outbound",
              timestamp: number(record.timestamp), bytesReceived: number(record.bytesReceived), packetsReceived: number(record.packetsReceived),
              lastPacketReceivedTimestamp: number(record.lastPacketReceivedTimestamp),
              totalSamplesReceived: number(record.totalSamplesReceived), totalAudioEnergy: number(record.totalAudioEnergy),
              concealedSamples: number(record.concealedSamples), bytesSent: number(record.bytesSent), packetsSent: number(record.packetsSent) });
          });
          return { peer: scope.id, connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState, statsFailed: false, audio };
        } catch {
          return { peer: scope.id, connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState, statsFailed: true, audio };
        }
      }));
      // Never expose raw reports, stats IDs, candidates, SDP, addresses or credentials.
      return { sampledAtMs: Date.now(), peers: samples.filter(sample => sample !== null) };
    };
  });
}

export async function readFreshAudioObservation(page: Page): Promise<FreshAudioObservation> {
  return page.evaluate(async () => {
    const read = (window as unknown as { __publicDemoFreshAudio?: () => Promise<FreshAudioObservation> }).__publicDemoFreshAudio;
    const unavailable = (reason: FreshAudioObservation["unavailable"]): FreshAudioObservation => ({ sampledAtMs: Date.now(), peers: [], unavailable: reason });
    if (typeof read !== "function") return unavailable("not-installed");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(read), new Promise<FreshAudioObservation>(resolve => {
        timer = setTimeout(() => resolve(unavailable("timeout")), 2_000);
      })]);
    } catch { return unavailable("error"); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }).catch((): FreshAudioObservation => ({ sampledAtMs: Date.now(), peers: [], unavailable: "error" }));
}
