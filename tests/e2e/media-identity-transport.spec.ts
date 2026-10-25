import { expect, test, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { startLocalLiveKitFixture } from "./local-livekit-fixture";

test.use({ trace: "off", screenshot: "off", video: "off", launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });
const { RoomServiceClient } = createRequire(resolve("apps/api/package.json"))("livekit-server-sdk");

// One LiveKit version: the one every deployment pins.
for (const version of ["1.13.9"] as const) {
  test(`scoped identity transport on LiveKit ${version} preserves microphone and cannot widen a different source class`, async ({ browser }) => {
    test.setTimeout(180_000);
    const livekit = await startLocalLiveKitFixture(version), pages: Page[] = [];
    try {
      const { createUserMediaIdentity } = await import(pathToFileURL(resolve("packages/shared-types/dist/media-identity.js")).href);
      const { captureMediaCredentialPlan, signMediaCredential } = await import(pathToFileURL(resolve("apps/api/dist/media-credential.js")).href);
      const room = "owned-scoped-media-transport", participantId = "界".repeat(200);
      const service = new RoomServiceClient(livekit.httpUrl, "devkey", "secret");
      async function credential(domain: string, scope: "m" | "s" | "ms") {
        const identity = await createUserMediaIdentity(room, { participantId: domain, scope });
        const sources = scope === "m" ? ["microphone"] : scope === "s" ? ["screen_share", "screen_share_audio"] : ["microphone", "screen_share", "screen_share_audio"];
        const plan = captureMediaCredentialPlan({ apiKey: "devkey", apiSecret: "secret", ...identity, name: "Owned media test",
          grant: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishSources: sources },
          ttlSeconds: 300, proofExpiresAtSeconds: Math.floor(Date.now() / 1000) + 300, livekitUrl: livekit.url });
        const signed = await signMediaCredential(plan, Date.now());
        expect(!!signed).toBe(true); return { ...identity, token: signed!.token };
      }
      async function connect(token: string) {
        const page = await browser.newPage(); pages.push(page); await page.goto(livekit.httpUrl);
        await page.addScriptTag({ path: resolve("apps/runtime-web/node_modules/livekit-client/dist/livekit-client.umd.js") });
        expect(await page.evaluate(async input => {
          const root = window as any, L = root.LivekitClient, room = new L.Room(), audio = new AudioContext(); await audio.resume();
          root.__scopeProbe = { room, audio, receivedMic: null, frames: 0 };
          room.on(L.RoomEvent.TrackSubscribed, (track: any) => {
            const element = track.attach(); document.body.append(element); void element.play().catch(() => undefined);
            if (track.kind === "video") {
              const frame = () => { root.__scopeProbe.frames++; element.requestVideoFrameCallback(frame); }; element.requestVideoFrameCallback(frame);
            } else if (track.source === "microphone") {
              const analyser = audio.createAnalyser(); analyser.fftSize = 256;
              audio.createMediaStreamSource(new MediaStream([track.mediaStreamTrack])).connect(analyser); root.__scopeProbe.receivedMic = analyser;
              root.__scopeProbe.receivedMicTrack = track;
            }
          });
          try { await room.connect(input.url, input.token); return true; } catch { return false; }
        }, { url: livekit.url, token })).toBe(true);
        return page;
      }
      async function publish(page: Page, sources: string[], bypass = false) {
        return page.evaluate(async input => {
          const root = window as any, probe = root.__scopeProbe, local = probe.room.localParticipant;
          if (input.bypass) { local.permissions.canPublish = true; local.permissions.canPublishSources = []; }
          for (const source of input.sources) {
            let track: MediaStreamTrack;
            if (source === "screen_share") {
              const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 90;
              const context = canvas.getContext("2d")!; let tick = 0;
              setInterval(() => { context.fillStyle = tick++ % 2 ? "#114477" : "#77aa33"; context.fillRect(0, 0, 160, 90); }, 50);
              track = canvas.captureStream(20).getVideoTracks()[0];
            } else {
              const oscillator = probe.audio.createOscillator(), gain = probe.audio.createGain(), sink = probe.audio.createMediaStreamDestination();
              gain.gain.value = 0.05; oscillator.connect(gain).connect(sink); oscillator.start(); track = sink.stream.getAudioTracks()[0];
            }
            try { await local.publishTrack(track, { source }); }
            catch { track.stop(); return false; }
          }
          return true;
        }, { sources, bypass });
      }
      const combined = await credential(participantId, "ms"), screen = await credential(participantId, "s");
      expect(combined.identity).not.toBe(screen.identity);
      expect((await credential(participantId, "ms")).identity).toBe(combined.identity);
      const receiver = await connect((await credential("observer", "m")).token);
      const old = await connect(combined.token);
      const oldSid = (await service.getParticipant(room, combined.identity)).sid;
      const publisher = await connect(combined.token);
      const before = await service.getParticipant(room, combined.identity);
      expect(before.sid === oldSid).toBe(false);
      await expect.poll(() => old.evaluate(() => (window as any).__scopeProbe.room.state), { timeout: 10_000 }).toBe("disconnected");
      expect(before.attributes.vrataMediaBinding).toBe(combined.attributes.vrataMediaBinding);
      expect(before.permission.canPublishData).toBe(true); expect(before.permission.canUpdateMetadata).toBe(false);
      expect(await publish(publisher, ["microphone", "screen_share", "screen_share_audio"])).toBe(true);
      const microphoneSid = (await service.getParticipant(room, combined.identity)).tracks.find((track: any) => track.source === 2)?.sid;
      expect(typeof microphoneSid).toBe("string");
      const screenOnly = await connect(screen.token);
      expect(await publish(screenOnly, ["screen_share", "screen_share_audio"])).toBe(true);
      const screenSid = (await service.getParticipant(room, screen.identity)).sid;
      await expect.poll(() => receiver.evaluate(() => (window as any).__scopeProbe.frames), { timeout: 15_000 }).toBeGreaterThan(2);
      // Suppress client permission handling: only the native server can remove these publications.
      for (const page of [publisher, screenOnly]) await page.evaluate(() => { (window as any).__scopeProbe.room.localParticipant.setPermissions = () => false; });
      const micOnly = { canPublish: true, canSubscribe: true, canPublishData: true, canPublishSources: [2] };
      const noPublish = { canPublish: false, canSubscribe: true, canPublishData: true, canPublishSources: [] };
      await service.updateParticipant(room, combined.identity, { permission: micOnly });
      const unaffected = await service.getParticipant(room, screen.identity);
      expect(unaffected.sid === screenSid).toBe(true); expect(unaffected.permission.canPublishSources.includes(2)).toBe(false);
      expect(await publish(screenOnly, ["microphone"], true)).toBe(false);
      expect((await service.getParticipant(room, screen.identity)).tracks.some((track: any) => track.source === 2)).toBe(false);
      await service.updateParticipant(room, screen.identity, { permission: noPublish });
      await service.updateParticipant(room, combined.identity, { permission: micOnly });
      await service.updateParticipant(room, screen.identity, { permission: noPublish });
      await expect.poll(async () => {
        const current = await service.getParticipant(room, combined.identity), stopped = await service.getParticipant(room, screen.identity);
        return current.sid === before.sid && current.tracks.length === 1 && current.tracks[0].source === 2
          && current.tracks[0].sid === microphoneSid && !current.tracks[0].muted
          && stopped.tracks.length === 0 && stopped.permission.canPublish === false;
      }, { timeout: 15_000 }).toBe(true);
      await expect.poll(() => receiver.evaluate(() => {
        const analyser = (window as any).__scopeProbe.receivedMic as AnalyserNode | null;
        if (!analyser) return false;
        const samples = new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(samples);
        return samples.some(sample => Math.abs(sample - 128) > 2);
      }), { timeout: 15_000 }).toBe(true);
      expect(await publish(screenOnly, ["screen_share"], true)).toBe(false);
      expect((await service.getParticipant(room, screen.identity)).tracks.length).toBe(0);
      // This remains a documented self-hosted limitation, not token revocation acceptance.
      await publisher.evaluate(() => (window as any).__scopeProbe.room.disconnect());
      const rejoined = await connect(combined.token);
      expect((await service.getParticipant(room, combined.identity)).permission.canPublishSources).toEqual([2, 3, 4]);
      // A muted microphone must not poison the SDK recycle pool for subsequent surface audio.
      expect(await publish(rejoined, ["microphone"])).toBe(true);
      const replacementMicSid = (await service.getParticipant(room, combined.identity)).tracks.find((track: any) => track.source === 2)?.sid;
      await expect.poll(() => receiver.evaluate(sid => (window as any).__scopeProbe.receivedMicTrack?.sid === sid, replacementMicSid), { timeout: 10_000 }).toBe(true);
      const surfaceModule = await readFile(resolve("apps/runtime-web/dist/media/media-surface-audio-runtime.js"), "utf8");
      await receiver.addScriptTag({ type: "module", content: `${surfaceModule}\nglobalThis.__ownedSurfaceAudioFactory = createMediaSurfaceAudioRuntime;` });
      await receiver.evaluate(() => {
        const root = window as any, probe = root.__scopeProbe, track = probe.receivedMicTrack;
        const element = track.attachedElements[0] as HTMLAudioElement;
        const source = probe.audio.createMediaElementSource(element); source.connect(probe.audio.destination);
        probe.previousMicElement = element; probe.previousMicSource = source;
        const nodes = new Map(); probe.surfaceNodes = nodes;
        const surface = root.__ownedSurfaceAudioFactory({
          roomMediaObjects: { surfaces: { screen: {} } }, livekitRoom: probe.room,
          mediaSurfaceViews: new Map([["screen", {}]]), mediaSurfaceAudioNodes: nodes,
          getTrackNodeId: (track: any) => track.sid, ensureAudioContext: () => probe.audio,
          createAudioAnalyser: () => { const analyser = probe.audio.createAnalyser(); analyser.fftSize = 256; return { analyser, sampleBuffer: new Uint8Array(256) }; },
          resumeAudioContext: () => probe.audio.resume(), reconcileMediaRoomIdleDisconnect() {}, syncSurfaceAudioControl() {}
        });
        probe.room.removeAllListeners(root.LivekitClient.RoomEvent.TrackSubscribed);
        probe.room.on(root.LivekitClient.RoomEvent.TrackSubscribed, (track: any) => {
          if (track.source === "screen_share_audio") surface.connectMediaSurfaceAudioTrack(track, "screen");
        });
      });
      await rejoined.evaluate(() => (window as any).__scopeProbe.room.localParticipant.setMicrophoneEnabled(false));
      await receiver.evaluate(() => {
        const probe = (window as any).__scopeProbe;
        probe.receivedMicTrack.detach(probe.previousMicElement);
        probe.previousMicElement.remove(); probe.previousMicSource.disconnect();
      });
      expect(await publish(rejoined, ["screen_share_audio"])).toBe(true);
      await expect.poll(() => receiver.evaluate(() => (window as any).__scopeProbe.surfaceNodes.has("screen")), { timeout: 10_000 }).toBe(true);
      await expect.poll(() => receiver.evaluate(() => {
        const node = (window as any).__scopeProbe.surfaceNodes.get("screen"), analyser = node.analyser as AnalyserNode;
        const samples = new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(samples);
        return !node.element.paused && !node.element.muted && node.element.volume > 0
          && samples.some(sample => Math.abs(sample - 128) > 2);
      }), { timeout: 15_000 }).toBe(true);
      // Test graph ownership separately from decoded signal. Chromium's MediaElementSource
      // analyser is silent for a srcObject even in an oscillator-only positive control.
      expect(await receiver.evaluate(async () => {
        const probe = (window as any).__scopeProbe, element = probe.surfaceNodes.get("screen").element;
        if (element === probe.previousMicElement) return false;
        await element.play();
        const source = probe.audio.createMediaElementSource(element); source.disconnect();
        return true;
      })).toBe(true);
    } finally { await Promise.allSettled(pages.map(page => page.close())); await livekit.close(); }
  });
}
