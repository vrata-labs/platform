import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { installFreshAudioObservation, readFreshAudioObservation } from "./fresh-audio-observation";
import { createAudioProgressTracker, hasLiveAudio } from "./audio-progress";
import type { FreshAudioObservation } from "./fresh-audio-observation";
import { startLocalLiveKitFixture } from "./local-livekit-fixture";

test.use({ trace: "off", screenshot: "off", video: "off", launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

test("audio progress requires fresh decoded signal on one stream, including after reconnect", () => {
  function snapshot(value: number, peer = 1): FreshAudioObservation {
    return { sampledAtMs: value, peers: [{ peer, connectionState: "connected", iceConnectionState: "connected", statsFailed: false,
      audio: [{ stream: 1, direction: "inbound", timestamp: value, lastPacketReceivedTimestamp: value,
        bytesReceived: value, packetsReceived: value, totalSamplesReceived: value, totalAudioEnergy: value / 1000 },
      { stream: 2, direction: "outbound", timestamp: value, bytesSent: value, packetsSent: value }] }] };
  }
  const baseline = snapshot(1000), progressed = snapshot(2000), progress = createAudioProgressTracker(baseline);
  expect(hasLiveAudio(baseline)).toBe(true);
  expect(progress(baseline)).toBe(false);
  expect(progress(progressed)).toBe(true);
  for (const key of ["timestamp", "bytesReceived", "packetsReceived", "totalSamplesReceived", "totalAudioEnergy"]) {
    const current = snapshot(2000); current.peers[0].audio[0][key] = baseline.peers[0].audio[0][key];
    expect(createAudioProgressTracker(baseline)(current)).toBe(false);
  }
  const stalled = snapshot(20_000); stalled.peers[0].audio[0].lastPacketReceivedTimestamp = 2000;
  expect(createAudioProgressTracker(baseline)(stalled)).toBe(false);
  const failed = snapshot(2000); failed.peers[0].statsFailed = true;
  expect(hasLiveAudio(failed)).toBe(false);
  const closed = snapshot(2000); closed.peers[0].connectionState = "closed"; closed.peers[0].iceConnectionState = "closed";
  expect(createAudioProgressTracker(baseline)(closed)).toBe(false);
  const reconnect = createAudioProgressTracker(baseline);
  expect(reconnect(snapshot(50, 2))).toBe(false);
  expect(reconnect(snapshot(100, 2))).toBe(true);
  const reset = createAudioProgressTracker(baseline);
  expect(reset(snapshot(50))).toBe(false);
  expect(reset(snapshot(100))).toBe(true);
  const newStream = snapshot(2000); newStream.peers[0].audio[0].stream = 3;
  const replaced = createAudioProgressTracker(baseline);
  expect(replaced(newStream)).toBe(false);
  const newStreamGrowth = snapshot(3000); newStreamGrowth.peers[0].audio[0].stream = 3;
  expect(replaced(newStreamGrowth)).toBe(true);
  for (const key of ["timestamp", "lastPacketReceivedTimestamp", "bytesReceived", "packetsReceived", "totalSamplesReceived", "totalAudioEnergy"]) {
    for (const invalid of [null, -1, Number.NaN]) {
      const missing = snapshot(2000); missing.peers[0].audio[0][key] = invalid;
      expect(hasLiveAudio(missing)).toBe(false);
      expect(createAudioProgressTracker(baseline)(missing)).toBe(false);
    }
  }
  const silent = snapshot(2000); silent.peers[0].audio[0].totalAudioEnergy = 0;
  expect(hasLiveAudio(silent)).toBe(false);
  const inboundOnly = snapshot(2000); inboundOnly.peers[0].audio.pop();
  expect(hasLiveAudio(inboundOnly)).toBe(false);
  const outboundOnly = snapshot(2000); outboundOnly.peers[0].audio.shift();
  expect(hasLiveAudio(outboundOnly)).toBe(false);
  expect(createAudioProgressTracker(baseline)(outboundOnly)).toBe(false);
  expect(hasLiveAudio({ sampledAtMs: 2000, peers: [], unavailable: "timeout" })).toBe(false);
});

test("fresh audio diagnostics observe real decoded audio, silence and closed peers without raw RTC records", async ({ browser }) => {
  test.setTimeout(180_000);
  const livekit = await startLocalLiveKitFixture();
  const contexts = [];
  try {
    const { AccessToken } = createRequire(resolve("apps/api/package.json"))("livekit-server-sdk");
    const pages = [];
    for (const identity of ["audio-observer", "audio-publisher"]) {
      const context = await browser.newContext(); contexts.push(context);
      await installFreshAudioObservation(context);
      const page = await context.newPage(); pages.push(page);
      await page.goto(livekit.httpUrl);
      await page.addScriptTag({ path: resolve("apps/runtime-web/node_modules/livekit-client/dist/livekit-client.umd.js") });
      const token = new AccessToken("devkey", "secret", { identity, ttl: "120s" });
      token.addGrant({ room: "owned-audio-observation", roomJoin: true, canPublish: true, canSubscribe: true });
      expect(await page.evaluate(async input => {
        const root = window as any, room = new root.LivekitClient.Room(); root.__ownedAudioRoom = room;
        room.on(root.LivekitClient.RoomEvent.TrackSubscribed, (track: any) => {
          const element = track.attach(); document.body.append(element); void element.play().catch(() => undefined);
        });
        try { await room.connect(input.url, input.token); return true; } catch { return false; }
      }, { url: livekit.url, token: await token.toJwt() })).toBe(true);
    }
    const [listener, publisher] = pages;
    await publisher.evaluate(async () => {
      const context = new AudioContext(), oscillator = context.createOscillator(), gain = context.createGain(), sink = context.createMediaStreamDestination();
      gain.gain.value = 0.08; oscillator.connect(gain).connect(sink); oscillator.start(); await context.resume();
      (window as any).__ownedAudioGain = gain;
      await (window as any).__ownedAudioRoom.localParticipant.publishTrack(sink.stream.getAudioTracks()[0], { source: "microphone" });
    });
    const inbound = async () => (await readFreshAudioObservation(listener)).peers
      .flatMap((peer: any) => peer.audio.map((audio: any) => ({ ...audio, peer: peer.peer })))
      .find((audio: any) => audio.direction === "inbound");
    await expect.poll(async () => (await inbound())?.totalAudioEnergy ?? 0, { timeout: 20_000 }).toBeGreaterThan(0);
    const baseline = await inbound();
    const progress = createAudioProgressTracker(await readFreshAudioObservation(listener));
    await expect.poll(async () => {
      const current = await inbound();
      return current?.peer === baseline.peer && current?.stream === baseline.stream
        && current.timestamp > baseline.timestamp && current.packetsReceived > baseline.packetsReceived
        && current.totalSamplesReceived > baseline.totalSamplesReceived && current.totalAudioEnergy > baseline.totalAudioEnergy;
    }, { timeout: 10_000 }).toBe(true);
    await expect.poll(async () => progress(await readFreshAudioObservation(listener)), { timeout: 10_000 }).toBe(true);
    const snapshot = await readFreshAudioObservation(listener);
    expect(Object.keys(snapshot).sort()).toEqual(["peers", "sampledAtMs"]);
    for (const peer of snapshot.peers) {
      expect(Object.keys(peer).sort()).toEqual(["audio", "connectionState", "iceConnectionState", "peer", "statsFailed"]);
      expect(peer.statsFailed).toBe(false);
      for (const audio of peer.audio) expect(Object.keys(audio).sort()).toEqual([
        "bytesReceived", "bytesSent", "concealedSamples", "direction", "lastPacketReceivedTimestamp", "packetsReceived", "packetsSent", "stream",
        "timestamp", "totalAudioEnergy", "totalSamplesReceived"
      ]);
    }
    await publisher.evaluate(() => { (window as any).__ownedAudioGain.gain.value = 0; });
    await listener.waitForTimeout(3_000);
    const silentBaseline = await inbound();
    const silentProgress = createAudioProgressTracker(await readFreshAudioObservation(listener));
    await listener.waitForTimeout(2_000);
    const silent = await inbound();
    expect(silent.timestamp).toBeGreaterThan(silentBaseline.timestamp);
    expect(silent.totalSamplesReceived).toBeGreaterThan(silentBaseline.totalSamplesReceived);
    expect(silent.totalAudioEnergy).toBe(silentBaseline.totalAudioEnergy);
    expect(silentProgress(await readFreshAudioObservation(listener))).toBe(false);
    await listener.evaluate(() => (window as any).__ownedAudioRoom.disconnect());
    await expect.poll(async () => (await readFreshAudioObservation(listener)).peers.length, { timeout: 5_000 }).toBe(0);
    await listener.evaluate(() => { (window as any).__publicDemoFreshAudio = async () => { throw new Error("must-not-be-returned"); }; });
    expect(await readFreshAudioObservation(listener)).toMatchObject({ peers: [], unavailable: "error" });
    await listener.evaluate(() => { (window as any).__publicDemoFreshAudio = () => new Promise(() => {}); });
    expect(await readFreshAudioObservation(listener)).toMatchObject({ peers: [], unavailable: "timeout" });
  } finally {
    await Promise.allSettled(contexts.map(context => context.close())); await livekit.close();
  }
});
