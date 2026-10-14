import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { installFreshAudioObservation, readFreshAudioObservation } from "./fresh-audio-observation";
import { startLocalLiveKitFixture } from "./local-livekit-fixture";

test.use({ trace: "off", screenshot: "off", video: "off", launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

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
    await expect.poll(async () => {
      const current = await inbound();
      return current?.peer === baseline.peer && current?.stream === baseline.stream
        && current.timestamp > baseline.timestamp && current.packetsReceived > baseline.packetsReceived
        && current.totalSamplesReceived > baseline.totalSamplesReceived && current.totalAudioEnergy > baseline.totalAudioEnergy;
    }, { timeout: 10_000 }).toBe(true);
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
    await listener.waitForTimeout(2_000);
    const silent = await inbound();
    expect(silent.timestamp).toBeGreaterThan(silentBaseline.timestamp);
    expect(silent.totalSamplesReceived).toBeGreaterThan(silentBaseline.totalSamplesReceived);
    expect(silent.totalAudioEnergy).toBe(silentBaseline.totalAudioEnergy);
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
