import test from "node:test";
import assert from "node:assert/strict";

import { collectWebRtcDiagnostics, createUnavailableWebRtcDiagnostics, type WebRtcStatsTransport } from "./webrtc-diagnostics.js";

function report(records: Array<[string, Record<string, unknown>]>): RTCStatsReport {
  return new Map(records) as unknown as RTCStatsReport;
}

test("createUnavailableWebRtcDiagnostics reports missing LiveKit transports", () => {
  const snapshot = createUnavailableWebRtcDiagnostics("not_joined", () => 123);

  assert.equal(snapshot.available, false);
  assert.equal(snapshot.capturedAtMs, 123);
  assert.equal(snapshot.unavailableReason, "not_joined");
  assert.deepEqual(snapshot.transports, []);
});

test("collectWebRtcDiagnostics reports selected TURN relay candidate", async () => {
  const transport: WebRtcStatsTransport = {
    role: "publisher",
    getConnectionState: () => "connected",
    getIceConnectionState: () => "connected",
    getSignalingState: () => "stable",
    getStats: async () => report([
      ["transport-1", { id: "transport-1", type: "transport", selectedCandidatePairId: "pair-1" }],
      ["pair-1", {
        id: "pair-1",
        type: "candidate-pair",
        state: "succeeded",
        nominated: true,
        currentRoundTripTime: 0.012,
        availableOutgoingBitrate: 1200000,
        bytesSent: 2048,
        bytesReceived: 1024,
        localCandidateId: "local-1",
        remoteCandidateId: "remote-1"
      }],
      ["local-1", { id: "local-1", type: "local-candidate", candidateType: "relay", protocol: "udp", relayProtocol: "tls", networkType: "wifi", url: "turns:livekit.example.test:5349" }],
      ["remote-1", { id: "remote-1", type: "remote-candidate", candidateType: "host", protocol: "udp" }]
    ])
  };

  const snapshot = await collectWebRtcDiagnostics([transport], { now: () => 456 });

  assert.equal(snapshot.available, true);
  assert.equal(snapshot.capturedAtMs, 456);
  assert.equal(snapshot.relayCandidateAvailable, true);
  assert.equal(snapshot.relaySelected, true);
  assert.equal(snapshot.turnUrlAvailable, true);
  assert.equal(snapshot.transports[0]?.role, "publisher");
  assert.equal(snapshot.transports[0]?.selectedCandidatePair?.localCandidate?.candidateType, "relay");
  assert.equal(snapshot.transports[0]?.selectedCandidatePair?.localCandidate?.urlProtocol, "turns");
  assert.deepEqual(snapshot.transports[0]?.localCandidateTypes, ["relay"]);
});

test("collectWebRtcDiagnostics falls back to nominated succeeded pair", async () => {
  const transport: WebRtcStatsTransport = {
    role: "subscriber",
    getStats: async () => report([
      ["pair-1", { id: "pair-1", type: "candidate-pair", state: "waiting", nominated: false, localCandidateId: "local-1", remoteCandidateId: "remote-1" }],
      ["pair-2", { id: "pair-2", type: "candidate-pair", state: "succeeded", nominated: true, localCandidateId: "local-2", remoteCandidateId: "remote-2" }],
      ["local-1", { id: "local-1", type: "local-candidate", candidateType: "host", protocol: "udp" }],
      ["remote-1", { id: "remote-1", type: "remote-candidate", candidateType: "host", protocol: "udp" }],
      ["local-2", { id: "local-2", type: "local-candidate", candidateType: "srflx", protocol: "udp" }],
      ["remote-2", { id: "remote-2", type: "remote-candidate", candidateType: "srflx", protocol: "udp" }]
    ])
  };

  const snapshot = await collectWebRtcDiagnostics([transport], { now: () => 789 });

  assert.equal(snapshot.available, true);
  assert.equal(snapshot.relayCandidateAvailable, false);
  assert.equal(snapshot.relaySelected, false);
  assert.equal(snapshot.transports[0]?.selectedCandidatePair?.localCandidate?.candidateType, "srflx");
  assert.deepEqual(snapshot.transports[0]?.localCandidateTypes, ["host", "srflx"]);
});

test("collectWebRtcDiagnostics keeps transport state when getStats fails", async () => {
  const transport: WebRtcStatsTransport = {
    role: "publisher",
    getConnectionState: () => "failed",
    getIceConnectionState: () => "failed",
    getSignalingState: () => "stable",
    getStats: async () => {
      throw Object.assign(new Error("boom"), { name: "OperationError" });
    }
  };

  const snapshot = await collectWebRtcDiagnostics([transport], { now: () => 101 });

  assert.equal(snapshot.available, false);
  assert.equal(snapshot.unavailableReason, "get_stats_failed");
  assert.equal(snapshot.transports[0]?.connectionState, "failed");
  assert.equal(snapshot.transports[0]?.errorCode, "get_stats_failed:OperationError");
});
