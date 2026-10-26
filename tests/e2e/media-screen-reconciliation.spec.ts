import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startLocalLiveKitFixture } from "./local-livekit-fixture";
import { startReferenceTemplateFixture } from "./reference-template-fixture";

test.use({ trace: "off", screenshot: "off", video: "off", launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });
const requireApi = createRequire(resolve("apps/api/package.json"));
const { RoomServiceClient, AccessToken } = requireApi("livekit-server-sdk");

/** Only the API's native RoomService RPCs pass through this owned fault bridge.
 * Browser signaling connects directly to the same real SFU, with real API-issued JWTs. */
async function faultBridge(upstream: string) {
  let failUpdates = false, loseNextAck = false, deniedUpdates = 0, lostAcks = 0;
  let failRemovals = false, loseNextRemovalAck = false, deniedRemovals = 0, lostRemovalAcks = 0;
  const server = createServer((incoming, outgoing) => {
    const update = incoming.url === "/twirp/livekit.RoomService/UpdateParticipant";
    const removal = incoming.url === "/twirp/livekit.RoomService/RemoveParticipant";
    if (update && failUpdates || removal && failRemovals) {
      if (removal) deniedRemovals++; else deniedUpdates++;
      incoming.resume(); outgoing.writeHead(503, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ code: "unavailable", msg: "owned_fixture_update_unavailable" })); return;
    }
    const loseAck = update && loseNextAck || removal && loseNextRemovalAck;
    if (loseAck) { if (removal) loseNextRemovalAck = false; else loseNextAck = false; }
    const request = httpRequest(new URL(incoming.url!, upstream), { method: incoming.method, headers: incoming.headers }, response => {
      if (loseAck && response.statusCode === 200) {
        response.resume(); response.once("end", () => {
          if (removal) lostRemovalAcks++; else lostAcks++;
          outgoing.writeHead(503, { "content-type": "application/json" });
          outgoing.end(JSON.stringify({ code: "unavailable", msg: "owned_fixture_ack_lost" }));
        });
      } else { outgoing.writeHead(response.statusCode!, response.headers); response.pipe(outgoing); }
    });
    request.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(503); outgoing.end(); });
    incoming.pipe(request);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  return { url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
    failUpdates: (value: boolean) => { failUpdates = value; }, loseNextAck: () => { loseNextAck = true; },
    failRemovals: (value: boolean) => { failRemovals = value; }, loseNextRemovalAck: () => { loseNextRemovalAck = true; },
    counts: () => ({ deniedUpdates, lostAcks, deniedRemovals, lostRemovalAcks }),
    close: async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } };
}

async function activateOwnedFixture(fixture: Awaited<ReturnType<typeof startReferenceTemplateFixture>>, mediaCodec: 2 | 3 = 2) {
  expect(fixture.schema).toMatch(/^template_e2e_[0-9a-f]{32}$/);
  const { Pool } = requireApi("pg"), pool = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL, options: `-c search_path=${fixture.schema},public` });
  try {
    expect((await pool.query("select current_schema() as name")).rows[0].name).toBe(fixture.schema);
    expect((await pool.query("select n.nspname from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.oid='room_identity_protocol_policy'::regclass")).rows[0].nspname).toBe(fixture.schema);
    const { PostgresStorage } = await import(pathToFileURL(resolve("apps/api/dist/storage.js")).href);
    const storage = new PostgresStorage(pool);
    await storage.identityProtocol.raise(2);
    if (mediaCodec === 3) expect(await storage.identityProtocol.raiseMediaCodec(3)).toBe(3);
  } finally { await pool.end(); }
}

async function connect(page: Page, native: Awaited<ReturnType<typeof startLocalLiveKitFixture>>, token: string) {
  await page.goto(native.httpUrl);
  await page.addScriptTag({ path: resolve("apps/runtime-web/node_modules/livekit-client/dist/livekit-client.umd.js") });
  expect(await page.evaluate(async input => {
    const root = window as any, L = root.LivekitClient, room = new L.Room(), audio = new AudioContext(); await audio.resume();
    const state = { room, audio, initialToken: input.token, frames: new Map<string, number>(), signals: new Map<string, AnalyserNode>() }; root.__s2 = state;
    room.on(L.RoomEvent.TrackSubscribed, (track: any) => {
      const element = track.attach(); document.body.append(element); void element.play().catch(() => undefined);
      if (track.kind === "video") {
        const frame = () => { state.frames.set(track.sid, (state.frames.get(track.sid) ?? 0) + 1); element.requestVideoFrameCallback(frame); };
        element.requestVideoFrameCallback(frame);
      } else {
        const analyser = audio.createAnalyser(); analyser.fftSize = 256;
        audio.createMediaStreamSource(new MediaStream([track.mediaStreamTrack])).connect(analyser); state.signals.set(track.sid, analyser);
      }
    });
    try { await room.connect(input.url, input.token); return true; } catch { return false; }
  }, { url: native.url, token })).toBe(true);
}

async function publish(page: Page, source: string, bypass = false) {
  return page.evaluate(async ({ source, bypass }) => {
    const state = (window as any).__s2, local = state.room.localParticipant;
    const previous = local.permissions.canPublishSources, allowed = local.permissions.canPublish;
    if (bypass) { local.permissions.canPublish = true; local.permissions.canPublishSources = []; }
    let track: MediaStreamTrack;
    if (source === "screen_share") {
      const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 90; const context = canvas.getContext("2d")!;
      let tick = 0; setInterval(() => { context.fillStyle = tick++ % 2 ? "#115599" : "#99bb22"; context.fillRect(0, 0, 160, 90); }, 50);
      track = canvas.captureStream(20).getVideoTracks()[0];
    } else {
      const oscillator = state.audio.createOscillator(), gain = state.audio.createGain(), sink = state.audio.createMediaStreamDestination();
      gain.gain.value = 0.05; oscillator.connect(gain).connect(sink); oscillator.start(); await state.audio.resume(); track = sink.stream.getAudioTracks()[0];
    }
    try { await local.publishTrack(track, { source }); return true; }
    catch { track.stop(); return false; }
    finally { if (bypass) { local.permissions.canPublishSources = previous; local.permissions.canPublish = allowed; } }
  }, { source, bypass });
}

const signal = (page: Page, sid: string) => page.evaluate(sid => {
  const analyser = (window as any).__s2.signals.get(sid) as AnalyserNode | undefined;
  if (!analyser) return false;
  const samples = new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(samples);
  return samples.some(sample => Math.abs(sample - 128) > 2);
}, sid);

for (const version of ["1.13.9"] as const) test(`server media reconciliation ${version}: screen revoke, terminal eviction and original/refreshed JWT replay`, async ({ browser, request }) => {
  test.setTimeout(240_000);
  const native = await startLocalLiveKitFixture(version), bridge = await faultBridge(native.httpUrl);
  let fixture: Awaited<ReturnType<typeof startReferenceTemplateFixture>> | undefined;
  const pages: Page[] = [];
  try {
    expect(!!process.env.VRATA_TEST_POSTGRES_URL).toBe(true);
    fixture = await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!, { livekitUrl: bridge.url, devRoleQuery: false,
      stateTokenSecret: "owned-server-screen-reconciler-secret-32-bytes" });
    const headers = { "x-vrata-admin-token": fixture.adminToken }, origin = fixture.origin;
    const created = await request.post(`${origin}/api/rooms`, { headers, data: { tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Owned reconciliation" } });
    expect(created.status()).toBe(201); const roomId = (await created.json()).roomId;
    await activateOwnedFixture(fixture);
    async function admit(role: "member" | "host") {
      const invitation = await request.post(`${origin}/api/rooms/${roomId}/invites`, { headers, data: { role, expiresInSeconds: 600 } }); expect(invitation.status()).toBe(201);
      const response = await request.post(`${origin}/api/tokens/state`, { data: { roomId, identityProtocolVersion: 2, inviteToken: (await invitation.json()).inviteToken, displayName: "Owned RTC participant" } });
      expect(response.status()).toBe(200); return response.json();
    }
    async function media(actor: any, audio: boolean, screen: boolean) {
      const response = await request.post(`${origin}/api/tokens/media`, { headers: { authorization: `Bearer ${actor.token}` },
        data: { roomId, participantId: actor.participantId, canPublishAudio: audio, canPublishVideo: screen } });
      expect(response.status()).toBe(200); const reply = await response.json();
      const claims = JSON.parse(Buffer.from(reply.token.split(".")[1], "base64url").toString("utf8"));
      return { token: reply.token as string, identity: claims.sub as string, room: claims.video.room as string };
    }
    const host = await admit("host"), former = await admit("member"), listener = await admit("member");
    for (const actor of [host, former]) {
      const presence = await request.put(`${origin}/api/rooms/${roomId}/presence/${actor.participantId}`, {
        headers: { authorization: `Bearer ${actor.token}` }, data: { participantId: actor.participantId, displayName: "Owned publisher", mode: "desktop", activeMedia: { audio: true, screenShare: false } }
      }); expect(presence.status()).toBe(200);
    }
    const initialControl = await request.get(`${origin}/api/rooms/${roomId}/session-control`, { headers }); expect(initialControl.status()).toBe(200);
    if ((await initialControl.json()).state.hostParticipantId !== host.participantId) {
      const transfer = await request.post(`${origin}/api/rooms/${roomId}/host/transfer`, { headers, data: { participantId: host.participantId } });
      expect(transfer.status()).toBe(200);
    }
    const grant = await request.post(`${origin}/api/rooms/${roomId}/presenters/${former.participantId}/grant`, { headers }); expect(grant.status()).toBe(200);
    const combined = await media(former, true, true), screen = await media(former, false, true), microphone = await media(former, true, false),
      hostMedia = await media(host, true, true), receiverMedia = await media(listener, true, false);
    const service = new RoomServiceClient(native.httpUrl, "devkey", "secret");
    const receiver = await browser.newPage(), ms = await browser.newPage(), s = await browser.newPage(), mic = await browser.newPage(), other = await browser.newPage(); pages.push(receiver, ms, s, mic, other);
    for (const [page, credential] of [[receiver, receiverMedia], [ms, combined], [s, screen], [mic, microphone], [other, hostMedia]] as const) await connect(page, native, credential.token);
    for (const source of ["microphone", "screen_share", "screen_share_audio"]) expect(await publish(ms, source)).toBe(true);
    for (const source of ["screen_share", "screen_share_audio"]) expect(await publish(s, source)).toBe(true);
    expect(await publish(other, "screen_share")).toBe(true);
    expect(await publish(other, "microphone")).toBe(true); expect(await publish(mic, "microphone")).toBe(true);
    const before = await service.getParticipant(combined.room, combined.identity), microphoneSid = before.tracks.find((track: any) => track.source === 2).sid;
    const screenSid = before.tracks.find((track: any) => track.source === 3).sid;
    await expect.poll(() => receiver.evaluate(sid => (window as any).__s2.frames.get(sid) ?? 0, screenSid), { timeout: 15_000 }).toBeGreaterThan(2);
    await expect.poll(() => signal(receiver, microphoneSid), { timeout: 15_000 }).toBe(true);
    expect(await publish(s, "microphone", true)).toBe(false);
    // These publishers have no room-state socket or role UI and ignore SDK permission updates.
    for (const page of [ms, s, mic, other]) await page.evaluate(() => { (window as any).__s2.room.localParticipant.setPermissions = () => false; });
    bridge.failUpdates(true);
    const revoke = await request.post(`${origin}/api/rooms/${roomId}/presenters/${former.participantId}/revoke`, { headers }); expect(revoke.status()).toBe(200);
    const committed = await revoke.json(); expect(committed.mediaScreenReconciliation.state).toBe("pending");
    expect(committed.mediaScreenReconciliation.enforcementVersion).toBe(4);
    await expect.poll(() => bridge.counts().deniedUpdates, { timeout: 10_000 }).toBeGreaterThan(0);
    const status = async () => { const response = await request.get(`${origin}/api/rooms/${roomId}/session-control`, { headers }); expect(response.status()).toBe(200); return (await response.json()).mediaScreenReconciliation; };
    expect((await status()).state).not.toBe("observed");
    expect((await service.getParticipant(combined.room, combined.identity)).tracks.some((track: any) => track.source === 3)).toBe(true);
    await fixture.restartApi();
    expect((await status()).state).not.toBe("observed");
    bridge.failUpdates(false); bridge.loseNextAck();
    await expect.poll(() => bridge.counts().lostAcks, { timeout: 10_000 }).toBe(1);
    await expect.poll(async () => (await status()).state, { timeout: 15_000 }).toBe("observed");
    expect((await status()).desiredVersion.authorityRevision).toBe(committed.revision);
    const after = await service.getParticipant(combined.room, combined.identity), stopped = await service.getParticipant(screen.room, screen.identity);
    expect(after.sid === before.sid).toBe(true); expect(after.permission.canPublishSources).toEqual([2]);
    expect(after.tracks.map((track: any) => track.sid)).toEqual([microphoneSid]); expect(stopped.permission.canPublish).toBe(false); expect(stopped.tracks.length).toBe(0);
    expect((await service.getParticipant(hostMedia.room, hostMedia.identity)).tracks.some((track: any) => track.source === 3)).toBe(true);
    await expect.poll(() => signal(receiver, microphoneSid), { timeout: 10_000 }).toBe(true);
    expect(await publish(ms, "screen_share", true)).toBe(false); expect(await publish(s, "microphone", true)).toBe(false);
    const denied = await request.post(`${origin}/api/tokens/media`, { headers: { authorization: `Bearer ${former.token}` },
      data: { roomId, participantId: former.participantId, canPublishAudio: true, canPublishVideo: true } }); expect(denied.status()).toBe(403);
    const cachedOriginal = await media(former, true, false);
    // Calibrate an actual SFU refresh while the participant is still admitted. Tokens
    // remain in the isolated browser/Node process, never traces, files or diagnostics.
    await service.updateParticipant(microphone.room, microphone.identity, { metadata: "owned-refresh-calibration" });
    await expect.poll(() => mic.evaluate(() => {
      try {
        const state = (window as any).__s2;
        const claims = (token: string) => JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        const original = claims(state.initialToken), refreshed = claims(state.room.engine.token);
        return refreshed.sub === original.sub && refreshed.attributes?.vrataMediaBinding === original.attributes?.vrataMediaBinding
          && refreshed.video?.canPublishSources?.join() === "microphone" && refreshed.exp > original.exp
          && refreshed.exp * 1000 - Date.now() > 9 * 60_000;
      } catch { return false; }
    }), { timeout: 10_000 }).toBe(true);
    const cachedRefreshed = await mic.evaluate(() => (window as any).__s2.room.engine.token as string);
    const targetIdentities = new Set([combined.identity, screen.identity, microphone.identity]);
    const remainingTargets = async () => (await service.listParticipants(combined.room)).filter((peer: any) => targetIdentities.has(peer.identity)).length;
    const hostMicSid = (await service.getParticipant(hostMedia.room, hostMedia.identity)).tracks.find((track: any) => track.source === 2).sid;
    bridge.failRemovals(true);
    const remove = await request.post(`${origin}/api/rooms/${roomId}/participants/${former.participantId}/remove`, { headers }); expect(remove.status()).toBe(200);
    const removed = await remove.json(); expect(removed.mediaScreenReconciliation.state).toBe("pending"); expect(removed.mediaScreenReconciliation.enforcementVersion).toBe(4);
    await expect.poll(() => bridge.counts().deniedRemovals, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(await remainingTargets()).toBe(3); expect((await status()).state).not.toBe("observed");
    await expect.poll(() => signal(receiver, microphoneSid), { timeout: 10_000 }).toBe(true);
    await fixture.restartApi(); expect((await status()).state).not.toBe("observed");
    bridge.failRemovals(false); bridge.loseNextRemovalAck();
    await expect.poll(() => bridge.counts().lostRemovalAcks, { timeout: 10_000 }).toBe(1);
    await expect.poll(remainingTargets, { timeout: 15_000 }).toBe(0);
    await expect.poll(async () => (await status()).state, { timeout: 15_000 }).toBe("observed");
    for (const page of [ms, s, mic]) await expect.poll(() => page.evaluate(() => (window as any).__s2.room.state), { timeout: 10_000 }).toBe("disconnected");
    await expect.poll(() => signal(receiver, hostMicSid), { timeout: 10_000 }).toBe(true);
    const deniedMic = await request.post(`${origin}/api/tokens/media`, { headers: { authorization: `Bearer ${former.token}` },
      data: { roomId, participantId: former.participantId, canPublishAudio: true, canPublishVideo: false } });
    const deniedMicBody = await deniedMic.json();
    expect({ status: deniedMic.status(), error: deniedMicBody.error, reason: deniedMicBody.reason }).toEqual({
      status: 409, error: "identity_required", reason: "identity_recovery_required"
    });
    for (const cached of [cachedOriginal.token, cachedRefreshed]) {
      const deniedBefore = bridge.counts().deniedRemovals;
      bridge.failRemovals(true);
      const replay = await browser.newPage(); pages.push(replay); await connect(replay, native, cached);
      expect(await publish(replay, "microphone")).toBe(true);
      await expect.poll(async () => (await service.getParticipant(microphone.room, microphone.identity)).tracks.some((track: any) => track.source === 2), { timeout: 10_000 }).toBe(true);
      const replayNative = await service.getParticipant(microphone.room, microphone.identity);
      const replayTrackSid = replayNative.tracks.find((track: any) => track.source === 2).sid;
      await expect.poll(() => signal(receiver, replayTrackSid), { timeout: 10_000 }).toBe(true);
      await expect.poll(() => bridge.counts().deniedRemovals, { timeout: 10_000 }).toBeGreaterThan(deniedBefore);
      expect((await status()).state).not.toBe("observed");
      bridge.failRemovals(false);
      await expect.poll(remainingTargets, { timeout: 15_000 }).toBe(0);
      await expect.poll(() => replay.evaluate(() => (window as any).__s2.room.state), { timeout: 10_000 }).toBe("disconnected");
      await expect.poll(async () => (await status()).state, { timeout: 15_000 }).toBe("observed");
      expect((await status()).desiredVersion.authorityRevision).toBe(removed.revision);
    }
    // End also evicts microphones and passive listeners, despite the retained Host slot.
    const end = await request.post(`${origin}/api/rooms/${roomId}/session-control/end`, { headers }); expect(end.status()).toBe(200);
    expect((await end.json()).mediaScreenReconciliation.state).toBe("pending");
    await expect.poll(async () => (await service.listParticipants(hostMedia.room)).length, { timeout: 15_000 }).toBe(0);
    await expect.poll(async () => (await status()).state, { timeout: 15_000 }).toBe("observed");
    expect((await status()).desiredVersion.roomActive).toBe(false);
    for (const page of [other, receiver]) await expect.poll(() => page.evaluate(() => (window as any).__s2.room.state), { timeout: 10_000 }).toBe("disconnected");
  } finally {
    await Promise.allSettled(pages.map(page => page.close()));
    try { await fixture?.close(); } finally { await bridge.close(); await native.close(); }
  }
});

for (const version of ["1.13.9"] as const) {
  for (const action of ["disable", "delete"] as const) test(`server media lifecycle ${version}: ${action} retires live microphone and listening connections`, async ({ browser, request }) => {
    test.setTimeout(180_000);
    const native = await startLocalLiveKitFixture(version);
    let fixture: Awaited<ReturnType<typeof startReferenceTemplateFixture>> | undefined;
    const pages: Page[] = [];
    try {
      expect(!!process.env.VRATA_TEST_POSTGRES_URL).toBe(true);
      fixture = await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!, { livekitUrl: native.url, devRoleQuery: false,
        stateTokenSecret: "owned-terminal-media-state-secret-32-bytes" });
      const origin = fixture.origin, headers = { "x-vrata-admin-token": fixture.adminToken };
      const created = await request.post(`${origin}/api/rooms`, { headers, data: { tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Owned metadata lifecycle" } });
      expect(created.status()).toBe(201); const roomId = (await created.json()).roomId;
      await activateOwnedFixture(fixture);
      async function admittedMicrophone() {
        const invitation = await request.post(`${origin}/api/rooms/${roomId}/invites`, { headers, data: { role: "member", expiresInSeconds: 600 } }); expect(invitation.status()).toBe(201);
        const admitted = await request.post(`${origin}/api/tokens/state`, { data: { roomId, identityProtocolVersion: 2, inviteToken: (await invitation.json()).inviteToken, displayName: "Owned microphone" } });
        expect(admitted.status()).toBe(200); const actor = await admitted.json();
        const response = await request.post(`${origin}/api/tokens/media`, { headers: { authorization: `Bearer ${actor.token}` },
          data: { roomId, participantId: actor.participantId, canPublishAudio: true, canPublishVideo: false } });
        expect(response.status()).toBe(200); const credential = await response.json();
        const claims = JSON.parse(Buffer.from(credential.token.split(".")[1], "base64url").toString("utf8"));
        return { token: credential.token as string, identity: claims.sub as string, room: claims.video.room as string };
      }
      const publisher = await admittedMicrophone(), listener = await admittedMicrophone(), page = await browser.newPage(), receiver = await browser.newPage(); pages.push(page, receiver);
      const service = new RoomServiceClient(native.httpUrl, "devkey", "secret");
      // A remote-browser executor publishing into the same native room, as the API grants it.
      const executorGrant = new AccessToken("devkey", "secret", { identity: "remote-browser:lifecycle-object", ttl: "600s" });
      executorGrant.addGrant({ room: publisher.room, roomJoin: true, canPublish: true, canSubscribe: false });
      const executor = await browser.newPage(); pages.push(executor);
      await connect(receiver, native, listener.token); await connect(page, native, publisher.token); await connect(executor, native, await executorGrant.toJwt());
      await executor.evaluate(() => { (window as any).__s2.room.localParticipant.setPermissions = () => false; });
      expect(await publish(page, "microphone")).toBe(true);
      await expect.poll(async () => (await service.getParticipant(publisher.room, publisher.identity)).tracks.some((track: any) => track.source === 2), { timeout: 10_000 }).toBe(true);
      const microphoneSid = (await service.getParticipant(publisher.room, publisher.identity)).tracks.find((track: any) => track.source === 2).sid;
      await expect.poll(() => signal(receiver, microphoneSid), { timeout: 10_000 }).toBe(true);
      for (const client of [page, receiver]) await client.evaluate(() => { (window as any).__s2.room.localParticipant.setPermissions = () => false; });
      const response = action === "disable" ? await request.post(`${origin}/api/rooms/${roomId}/disable`, { headers })
        : await request.delete(`${origin}/api/rooms/${roomId}`, { headers });
      expect(response.status()).toBe(200);
      // Delete is terminal: the executor goes too. Disable is reversible: the executor, which never reconnects, stays.
      const remaining = action === "delete" ? [] : ["remote-browser:lifecycle-object"];
      await expect.poll(async () => (await service.listParticipants(publisher.room)).map((peer: any) => peer.identity), { timeout: 15_000 }).toEqual(remaining);
      for (const client of [page, receiver]) await expect.poll(() => client.evaluate(() => (window as any).__s2.room.state), { timeout: 10_000 }).toBe("disconnected");
      await expect.poll(() => executor.evaluate(() => (window as any).__s2.room.state), { timeout: 10_000 }).toBe(action === "delete" ? "disconnected" : "connected");
      if (action === "disable") {
        expect((await request.post(`${origin}/api/rooms/${roomId}/enable`, { headers })).status()).toBe(200);
        const enabledPublisher = await browser.newPage(), enabledListener = await browser.newPage(); pages.push(enabledPublisher, enabledListener);
        await connect(enabledListener, native, listener.token); await connect(enabledPublisher, native, publisher.token);
        expect(await publish(enabledPublisher, "microphone")).toBe(true);
        await expect.poll(async () => (await service.getParticipant(publisher.room, publisher.identity)).tracks.some((track: any) => track.source === 2), { timeout: 10_000 }).toBe(true);
        const sid = (await service.getParticipant(publisher.room, publisher.identity)).tracks.find((track: any) => track.source === 2).sid;
        await expect.poll(() => signal(enabledListener, sid), { timeout: 10_000 }).toBe(true);
        await expect.poll(async () => {
          const control = await request.get(`${origin}/api/rooms/${roomId}/session-control`, { headers }); expect(control.status()).toBe(200);
          return (await control.json()).mediaScreenReconciliation.state;
        }, { timeout: 15_000 }).toBe("observed");
        expect((await service.listParticipants(publisher.room)).length).toBe(3);
      }
    } finally {
      await Promise.allSettled(pages.map(page => page.close()));
      try { await fixture?.close(); } finally { await native.close(); }
    }
  });
}

for (const version of ["1.13.9"] as const) test(`server media lineage ${version}: codec-3 recovery and room recreation retire only the old lineage`, async ({ browser, request }) => {
  test.setTimeout(240_000);
  const native = await startLocalLiveKitFixture(version), bridge = await faultBridge(native.httpUrl);
  let fixture: Awaited<ReturnType<typeof startReferenceTemplateFixture>> | undefined;
  const pages: Page[] = [];
  try {
    expect(!!process.env.VRATA_TEST_POSTGRES_URL).toBe(true);
    fixture = await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!, { livekitUrl: bridge.url, devRoleQuery: false,
      stateTokenSecret: "owned-media-lineage-state-secret-32-bytes" });
    const origin = fixture.origin, headers = { "x-vrata-admin-token": fixture.adminToken }, roomId = `lineage-${randomUUID()}`;
    const create = () => request.post(`${origin}/api/rooms`, { headers, data: { roomId, tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Owned media lineage" } });
    expect((await create()).status()).toBe(201);
    await activateOwnedFixture(fixture, 3);
    const health = await request.get(`${origin}/health`); expect((await health.json()).features.mediaIdentityCodec).toBe(3);
    async function admit(role: "member" | "host") {
      const invitation = await request.post(`${origin}/api/rooms/${roomId}/invites`, { headers, data: { role, expiresInSeconds: 600 } }); expect(invitation.status()).toBe(201);
      const response = await request.post(`${origin}/api/tokens/state`, { data: { roomId, identityProtocolVersion: 2, inviteToken: (await invitation.json()).inviteToken, displayName: "Owned lineage participant" } });
      expect(response.status()).toBe(200); return response.json();
    }
    async function media(actor: { token: string; participantId: string }) {
      const response = await request.post(`${origin}/api/tokens/media`, { headers: { authorization: `Bearer ${actor.token}` },
        data: { roomId, participantId: actor.participantId, canPublishAudio: true, canPublishVideo: false } });
      expect(response.status()).toBe(200); const reply = await response.json();
      const claims = JSON.parse(Buffer.from(reply.token.split(".")[1], "base64url").toString("utf8"));
      return { token: reply.token as string, identity: claims.sub as string, room: claims.video.room as string };
    }
    const stateOf = (page: Page) => page.evaluate(() => (window as any).__s2.room.state);
    const host = await admit("host"), listener = await admit("member");
    const presence = await request.put(`${origin}/api/rooms/${roomId}/presence/${host.participantId}`, {
      headers: { authorization: `Bearer ${host.token}` }, data: { participantId: host.participantId, displayName: "Owned lineage host", mode: "desktop", activeMedia: { audio: true, screenShare: false } }
    }); expect(presence.status()).toBe(200);
    const control = await request.get(`${origin}/api/rooms/${roomId}/session-control`, { headers }); expect(control.status()).toBe(200);
    if ((await control.json()).state.hostParticipantId !== host.participantId) {
      expect((await request.post(`${origin}/api/rooms/${roomId}/host/transfer`, { headers, data: { participantId: host.participantId } })).status()).toBe(200);
    }
    const original = await media(host), listening = await media(listener);
    expect(original.identity).toMatch(/^vmi3\.m\.[a-f0-9]{64}$/);
    expect(original.room).toMatch(/^vrata-v3:[a-f0-9]{32}:[a-f0-9]{32}:lineage-/);
    const service = new RoomServiceClient(native.httpUrl, "devkey", "secret");
    const receiver = await browser.newPage(), first = await browser.newPage(); pages.push(receiver, first);
    await connect(receiver, native, listening.token); await connect(first, native, original.token);
    expect(await publish(first, "microphone")).toBe(true);
    const firstSid = async () => (await service.getParticipant(original.room, original.identity)).tracks.find((track: any) => track.source === 2)?.sid;
    await expect.poll(firstSid, { timeout: 10_000 }).toBeTruthy();
    await expect.poll(async () => signal(receiver, (await firstSid())!), { timeout: 15_000 }).toBe(true);
    // An actual SFU-refreshed JWT of the original lineage, outliving the original encoded TTL.
    await service.updateParticipant(original.room, original.identity, { metadata: "owned-lineage-refresh" });
    await expect.poll(() => first.evaluate(() => {
      try {
        const state = (window as any).__s2;
        const claims = (token: string) => JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        const before = claims(state.initialToken), refreshed = claims(state.room.engine.token);
        return refreshed.sub === before.sub && refreshed.attributes?.vrataMediaBinding === before.attributes?.vrataMediaBinding && refreshed.exp > before.exp;
      } catch { return false; }
    }), { timeout: 10_000 }).toBe(true);
    const refreshed = await first.evaluate(() => (window as any).__s2.room.engine.token as string);
    await first.evaluate(() => { (window as any).__s2.room.localParticipant.setPermissions = () => false; });

    // Administrator recovery keeps the participant ID and advances its epoch.
    const issued = await request.post(`${origin}/api/rooms/${roomId}/identity-recovery`, { headers, data: { participantId: host.participantId, role: "host" } });
    expect(issued.status()).toBe(201);
    const redeemed = await request.post(`${origin}/api/tokens/state`, { data: { roomId, identityProtocolVersion: 2, recoveryCredential: (await issued.json()).recoveryCredential } });
    expect(redeemed.status()).toBe(200); const recoveredHost = await redeemed.json();
    expect(recoveredHost.participantId).toBe(host.participantId);
    const stale = await request.post(`${origin}/api/tokens/media`, { headers: { authorization: `Bearer ${host.token}` },
      data: { roomId, participantId: host.participantId, canPublishAudio: true, canPublishVideo: false } });
    expect(stale.status()).toBe(409); expect((await stale.json()).reason).toBe("identity_recovery_required");
    const recovered = await media(recoveredHost);
    expect(recovered.room).toBe(original.room); expect(recovered.identity).not.toBe(original.identity);
    await expect.poll(() => stateOf(first), { timeout: 15_000 }).toBe("disconnected");
    const second = await browser.newPage(); pages.push(second); await connect(second, native, recovered.token);
    expect(await publish(second, "microphone")).toBe(true);
    const secondSid = async () => (await service.getParticipant(recovered.room, recovered.identity)).tracks.find((track: any) => track.source === 2)?.sid;
    await expect.poll(secondSid, { timeout: 10_000 }).toBeTruthy();
    await expect.poll(async () => signal(receiver, (await secondSid())!), { timeout: 15_000 }).toBe(true);
    // Cached original and refreshed JWTs of the old lineage rejoin and are removed; the recovered address never is.
    for (const cached of [original.token, refreshed]) {
      // Hold native removals so the rejoin is observed, then release them: only the old address is removed.
      const deniedBefore = bridge.counts().deniedRemovals;
      bridge.failRemovals(true);
      const replay = await browser.newPage(); pages.push(replay); await connect(replay, native, cached);
      await replay.evaluate(() => { (window as any).__s2.room.localParticipant.setPermissions = () => false; });
      expect((await service.getParticipant(original.room, original.identity)).identity).toBe(original.identity);
      await expect.poll(() => bridge.counts().deniedRemovals, { timeout: 10_000 }).toBeGreaterThan(deniedBefore);
      bridge.failRemovals(false);
      await expect.poll(() => stateOf(replay), { timeout: 15_000 }).toBe("disconnected");
      expect(await stateOf(second)).toBe("connected");
    }
    await expect.poll(async () => {
      const status = await request.get(`${origin}/api/rooms/${roomId}/session-control`, { headers }); expect(status.status()).toBe(200);
      const reconciliation = (await status.json()).mediaScreenReconciliation;
      return `${reconciliation.enforcementVersion}:${reconciliation.state}`;
    }, { timeout: 15_000 }).toBe("4:observed");
    expect((await service.listParticipants(original.room)).map((peer: any) => peer.identity).sort()).toEqual([listening.identity, recovered.identity].sort());

    // Delete and recreate the same room ID: the old JWT names the previous generation and is retired there.
    expect((await request.delete(`${origin}/api/rooms/${roomId}`, { headers })).status()).toBe(200);
    for (const page of [receiver, second]) await expect.poll(() => stateOf(page), { timeout: 15_000 }).toBe("disconnected");
    expect((await create()).status()).toBe(201);
    const newcomer = await media(await admit("member"));
    expect(newcomer.room).not.toBe(listening.room);
    const fresh = await browser.newPage(), old = await browser.newPage(); pages.push(fresh, old);
    await connect(fresh, native, newcomer.token);
    // Held removals let the old JWT really enter its own, previous-generation native room first.
    const deniedBefore = bridge.counts().deniedRemovals;
    bridge.failRemovals(true);
    await connect(old, native, listening.token);
    await old.evaluate(() => { (window as any).__s2.room.localParticipant.setPermissions = () => false; });
    expect((await service.getParticipant(listening.room, listening.identity)).identity).toBe(listening.identity);
    await expect.poll(() => bridge.counts().deniedRemovals, { timeout: 10_000 }).toBeGreaterThan(deniedBefore);
    bridge.failRemovals(false);
    await expect.poll(() => stateOf(old), { timeout: 15_000 }).toBe("disconnected");
    expect((await service.listParticipants(newcomer.room)).map((peer: any) => peer.identity)).toEqual([newcomer.identity]);
    expect(await stateOf(fresh)).toBe("connected");
  } finally {
    await Promise.allSettled(pages.map(page => page.close()));
    try { await fixture?.close(); } finally { await bridge.close(); await native.close(); }
  }
});
