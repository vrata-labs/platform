import { test, expect, type Page } from "@playwright/test";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startLocalLiveKitFixture } from "./local-livekit-fixture";
import { startReferenceTemplateFixture } from "./reference-template-fixture";

test.use({ trace: "off", screenshot: "off", video: "off", launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });
const requireApi = createRequire(resolve("apps/api/package.json"));
const { RoomServiceClient } = requireApi("livekit-server-sdk");

/** Only the API's native RoomService RPCs pass through this owned fault bridge.
 * Browser signaling connects directly to the same real SFU, with real API-issued JWTs. */
async function faultBridge(upstream: string) {
  let failUpdates = false, loseNextAck = false, deniedUpdates = 0, lostAcks = 0;
  const server = createServer((incoming, outgoing) => {
    const update = incoming.url === "/twirp/livekit.RoomService/UpdateParticipant";
    if (update && failUpdates) {
      deniedUpdates++; incoming.resume(); outgoing.writeHead(503, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ code: "unavailable", msg: "owned_fixture_update_unavailable" })); return;
    }
    const loseAck = update && loseNextAck; if (loseAck) loseNextAck = false;
    const request = httpRequest(new URL(incoming.url!, upstream), { method: incoming.method, headers: incoming.headers }, response => {
      if (loseAck && response.statusCode === 200) {
        response.resume(); response.once("end", () => {
          lostAcks++; outgoing.writeHead(503, { "content-type": "application/json" });
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
    counts: () => ({ deniedUpdates, lostAcks }),
    close: async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } };
}

async function connect(page: Page, native: Awaited<ReturnType<typeof startLocalLiveKitFixture>>, token: string) {
  await page.goto(native.httpUrl);
  await page.addScriptTag({ path: resolve("apps/runtime-web/node_modules/livekit-client/dist/livekit-client.umd.js") });
  expect(await page.evaluate(async input => {
    const root = window as any, L = root.LivekitClient, room = new L.Room(), audio = new AudioContext(); await audio.resume();
    const state = { room, audio, frames: new Map<string, number>(), signals: new Map<string, AnalyserNode>() }; root.__s2 = state;
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

for (const version of ["1.13.7", "1.13.9"] as const) test(`server screen reconciliation ${version}: uncooperative RTC, failed RPC, API restart and lost ACK`, async ({ browser, request }) => {
  test.setTimeout(240_000);
  const native = await startLocalLiveKitFixture(version), bridge = await faultBridge(native.httpUrl);
  let fixture: Awaited<ReturnType<typeof startReferenceTemplateFixture>> | undefined;
  const pages: Page[] = [];
  try {
    expect(!!process.env.VRATA_TEST_POSTGRES_URL).toBe(true);
    fixture = await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!, { livekitUrl: bridge.url, devRoleQuery: false,
      stateTokenSecret: "owned-server-screen-reconciler-secret-32-bytes" });
    expect(fixture.schema).toMatch(/^template_e2e_[0-9a-f]{32}$/);
    const headers = { "x-vrata-admin-token": fixture.adminToken }, origin = fixture.origin;
    const created = await request.post(`${origin}/api/rooms`, { headers, data: { tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Owned reconciliation" } });
    expect(created.status()).toBe(201); const roomId = (await created.json()).roomId;
    const { Pool } = requireApi("pg"), pool = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL, options: `-c search_path=${fixture.schema},public` });
    try {
      expect((await pool.query("select current_schema() as name")).rows[0].name).toBe(fixture.schema);
      expect((await pool.query("select n.nspname from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.oid='room_identity_protocol_policy'::regclass")).rows[0].nspname).toBe(fixture.schema);
      const { PostgresStorage } = await import(pathToFileURL(resolve("apps/api/dist/storage.js")).href);
      await new PostgresStorage(pool).identityProtocol.raise(2);
    } finally { await pool.end(); }
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
    const combined = await media(former, true, true), screen = await media(former, false, true), hostMedia = await media(host, true, true), receiverMedia = await media(listener, true, false);
    const service = new RoomServiceClient(native.httpUrl, "devkey", "secret");
    const receiver = await browser.newPage(), ms = await browser.newPage(), s = await browser.newPage(), other = await browser.newPage(); pages.push(receiver, ms, s, other);
    for (const [page, credential] of [[receiver, receiverMedia], [ms, combined], [s, screen], [other, hostMedia]] as const) await connect(page, native, credential.token);
    for (const source of ["microphone", "screen_share", "screen_share_audio"]) expect(await publish(ms, source)).toBe(true);
    for (const source of ["screen_share", "screen_share_audio"]) expect(await publish(s, source)).toBe(true);
    expect(await publish(other, "screen_share")).toBe(true);
    const before = await service.getParticipant(combined.room, combined.identity), microphoneSid = before.tracks.find((track: any) => track.source === 2).sid;
    const screenSid = before.tracks.find((track: any) => track.source === 3).sid;
    await expect.poll(() => receiver.evaluate(sid => (window as any).__s2.frames.get(sid) ?? 0, screenSid), { timeout: 15_000 }).toBeGreaterThan(2);
    await expect.poll(() => signal(receiver, microphoneSid), { timeout: 15_000 }).toBe(true);
    expect(await publish(s, "microphone", true)).toBe(false);
    // These publishers have no room-state socket or role UI and ignore SDK permission updates.
    for (const page of [ms, s, other]) await page.evaluate(() => { (window as any).__s2.room.localParticipant.setPermissions = () => false; });
    bridge.failUpdates(true);
    const revoke = await request.post(`${origin}/api/rooms/${roomId}/presenters/${former.participantId}/revoke`, { headers }); expect(revoke.status()).toBe(200);
    const committed = await revoke.json(); expect(committed.mediaScreenReconciliation.state).toBe("pending");
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
    // End closes screen authority even though the Host identity slot remains populated.
    const end = await request.post(`${origin}/api/rooms/${roomId}/session-control/end`, { headers }); expect(end.status()).toBe(200);
    expect((await end.json()).mediaScreenReconciliation.state).toBe("pending");
    await expect.poll(async () => (await service.getParticipant(hostMedia.room, hostMedia.identity)).tracks.length, { timeout: 15_000 }).toBe(0);
    await expect.poll(async () => (await status()).state, { timeout: 15_000 }).toBe("observed");
    expect((await status()).desiredVersion.roomActive).toBe(false);
    // S2b is screen-only: original/refreshed JWT admission and microphone eviction remain S3.
    expect((await service.getParticipant(combined.room, combined.identity)).tracks[0].sid).toBe(microphoneSid);
  } finally {
    await Promise.allSettled(pages.map(page => page.close()));
    try { await fixture?.close(); } finally { await bridge.close(); await native.close(); }
  }
});
