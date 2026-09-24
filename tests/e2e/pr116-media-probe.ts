import type { Page } from "@playwright/test";

export async function instrumentMedia(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const pcs: RTCPeerConnection[] = [];
    const events: unknown[] = [];
    const start = performance.now();
    const log = (value: object) => { if (events.length < 200) events.push({ ms: Math.round(performance.now() - start), ...value }); };
    const original = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(original, {
      construct(target, args) {
        const pc = Reflect.construct(target, args) as RTCPeerConnection;
        const index = pcs.push(pc) - 1;
        log({ pc: index, event: "created" });
        for (const name of ["connectionstatechange", "iceconnectionstatechange", "icegatheringstatechange", "signalingstatechange", "negotiationneeded", "track"]) {
          pc.addEventListener(name, () => log({ pc: index, event: name, connection: pc.connectionState, ice: pc.iceConnectionState, gathering: pc.iceGatheringState, signaling: pc.signalingState }));
        }
        for (const name of ["createOffer", "createAnswer", "setLocalDescription", "setRemoteDescription", "addIceCandidate", "addTrack", "addTransceiver", "close"] as const) {
          const fn = (pc as any)[name];
          (pc as any)[name] = function (...values: unknown[]) {
            log({ pc: index, call: name });
            try {
              const result = fn.apply(pc, values);
              if (result?.then) result.then(() => log({ pc: index, resolved: name }), (error: Error) => log({ pc: index, rejected: name, errorName: error?.name }));
              return result;
            } catch (error) { log({ pc: index, thrown: name, errorName: (error as Error)?.name }); throw error; }
          };
        }
        return pc;
      }
    });
    (window as any).__mediaProbe = { captureCalls: 0 };
    (window as any).__readMediaProbe = async () => {
      const d = (window as any).__VRATA_DEBUG__;
      const transports = await Promise.all(pcs.map(async pc => {
        const stats: object[] = [];
        try {
          (await pc.getStats()).forEach(row => {
            if (!["transport", "outbound-rtp", "inbound-rtp", "candidate-pair"].includes(row.type)) return;
            if (row.type === "candidate-pair" && !row.nominated) return;
            const clean: Record<string, unknown> = {};
            for (const key of ["type", "kind", "state", "dtlsState", "iceState", "bytesSent", "bytesReceived", "packetsSent", "packetsReceived", "framesEncoded", "framesDecoded", "framesSent", "nominated"]) if (row[key] !== undefined) clean[key] = row[key];
            stats.push(clean);
          });
        } catch { /* A closed connection still has useful state. */ }
        return { connection: pc.connectionState, ice: pc.iceConnectionState, signaling: pc.signalingState, gathering: pc.iceGatheringState,
          localType: pc.localDescription?.type, remoteType: pc.remoteDescription?.type,
          senders: pc.getSenders().map(s => ({ kind: s.track?.kind, ready: s.track?.readyState, enabled: s.track?.enabled, muted: s.track?.muted, settings: s.track ? { width: s.track.getSettings().width, height: s.track.getSettings().height, frameRate: s.track.getSettings().frameRate } : null })), stats };
      }));
      return { events, transports, capture: (window as any).__mediaProbe,
        scene: d?.sceneBundleState, connected: d?.roomStateConnected, shareState: d?.screenShareState,
        objects: d?.mediaObjects?.objects?.map((o: any) => ({ type: o.type, status: o.status, revision: o.revision, mediaStatus: o.state?.status, hasSid: Boolean(o.state?.mediaTrackSid), errorCode: o.state?.errorCode, own: o.ownerParticipantId === d?.participantId })),
        visibility: document.visibilityState, buttons: ["start-share", "stop-share"].map(id => ({ id, disabled: (document.getElementById(id) as HTMLButtonElement)?.disabled })) };
    };
  });
}
