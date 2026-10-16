import { expect, test, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startLocalLiveKitFixture } from "./local-livekit-fixture.js";
import { startReferenceTemplateFixture } from "./reference-template-fixture.js";

// Genuine self-hosted RTC and the built main runtime. Credentials/SDP/candidates remain in memory, never in artifacts.
test.use({ trace: "off", screenshot: "off", video: "off", launchOptions: { args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] } });
test.describe.configure({ mode: "serial" });
const { RoomServiceClient, AccessToken } = createRequire(resolve("apps/api/package.json"))("livekit-server-sdk");
const STATE_SECRET = "owned-source-grants-browser-state-secret-32-bytes";
let livekit: Awaited<ReturnType<typeof startLocalLiveKitFixture>>;
test.beforeAll(async () => { test.setTimeout(240_000); expect(!!process.env.VRATA_TEST_POSTGRES_URL).toBe(true); livekit = await startLocalLiveKitFixture(); });
test.afterAll(async () => { await livekit?.close(); });

async function captureSetup(page: Page) {
  await page.addInitScript(() => {
    const observations = { starts: 0, streams: [] as MediaStream[], hold: false, release: () => {} };
    (window as any).__sourceCapture = observations;
    (window as any).__sourceJoinClicks = 0;
    document.addEventListener("click", event => {
      if ((event.target as Element | null)?.closest("#join-audio")) (window as any).__sourceJoinClicks++;
    }, true);
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", { configurable: true, value: async () => {
      observations.starts++;
      const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 180;
      const context = canvas.getContext("2d")!; let tick = 0;
      setInterval(() => { context.fillStyle = tick++ % 2 ? "#114477" : "#77aa33"; context.fillRect(0, 0, 320, 180); }, 50);
      const stream = canvas.captureStream(20);
      const audio = new AudioContext(), oscillator = audio.createOscillator(), gain = audio.createGain(), sink = audio.createMediaStreamDestination();
      gain.gain.value = 0.05; oscillator.connect(gain).connect(sink); oscillator.start(); void audio.resume();
      stream.addTrack(sink.stream.getAudioTracks()[0]); observations.streams.push(stream);
      if (observations.hold) await new Promise<void>(done => { observations.release = done; });
      return stream;
    } });
  });
}

async function observer(page: Page, origin: string, token: string) {
  await page.goto(`${origin}/health`);
  await page.addScriptTag({ path: resolve("apps/runtime-web/node_modules/livekit-client/dist/livekit-client.umd.js") });
  expect(await page.evaluate(async input => {
    const L = (window as any).LivekitClient, room = new L.Room(), audio = new AudioContext(); await audio.resume();
    const state = { room, frames: 0, samples: new Map<string, AnalyserNode>() }; (window as any).__sourceObserver = state;
    room.on(L.RoomEvent.TrackSubscribed, (track: any) => {
      const element = track.attach(); element.autoplay = true; document.body.append(element); void element.play().catch(() => undefined);
      if (track.kind === "video") {
        const next = () => { state.frames++; element.requestVideoFrameCallback(next); }; element.requestVideoFrameCallback(next);
      } else {
        const analyser = audio.createAnalyser(); analyser.fftSize = 256;
        audio.createMediaStreamSource(new MediaStream([track.mediaStreamTrack])).connect(analyser); state.samples.set(track.source, analyser);
      }
    });
    try { await room.connect(input.url, input.token); return true; } catch { return false; }
  }, { url: livekit.url, token })).toBe(true);
}

async function signal(page: Page, source: string) {
  return page.evaluate(source => {
    const analyser = (window as any).__sourceObserver?.samples.get(source) as AnalyserNode | undefined;
    if (!analyser) return false;
    const samples = new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(samples);
    return samples.some(sample => Math.abs(sample - 128) > 2);
  }, source);
}

async function roomFixture(request: any) {
  const fixture = await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!, { livekitUrl: livekit.url, devRoleQuery: false, stateTokenSecret: STATE_SECRET });
  const response = await request.post(`${fixture.origin}/api/rooms`, { headers: { "x-vrata-admin-token": fixture.adminToken },
    data: { tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Scoped media" } });
  if (response.status() !== 201) { await fixture.close(); throw new Error(`media_fixture_room_creation:${response.status()}`); }
  const roomId = (await response.json()).roomId as string;
  async function invite(role: "host" | "member") {
    const response = await request.post(`${fixture.origin}/api/rooms/${roomId}/invites`, { headers: { "x-vrata-admin-token": fixture.adminToken }, data: { role, expiresInSeconds: 600 } });
    expect(response.status()).toBe(201); return await response.json();
  }
  async function admit(role: "host" | "member", protocol: 1 | 2 = 1) {
    const invitation = await invite(role);
    const participantId = randomUUID();
    const response = await request.post(`${fixture.origin}/api/tokens/state`, { data: { roomId, participantId, identityProtocolVersion: protocol, inviteToken: invitation.inviteToken, displayName: "Media test" } });
    expect(response.status()).toBe(200); const issued = await response.json(), state = { ...issued, participantId: issued.participantId ?? participantId };
    const media = await request.post(`${fixture.origin}/api/tokens/media`, { headers: { authorization: `Bearer ${state.token}` },
      data: { roomId, participantId: state.participantId, canPublishAudio: true, canPublishVideo: role === "host" } });
    expect(media.status()).toBe(200); return { state, token: (await media.json()).token as string };
  }
  const service = new RoomServiceClient(livekit.httpUrl, "devkey", "secret");
  async function enableAudio(originalToken: string) {
    const { getRoomPermissions } = await import(pathToFileURL(resolve("packages/shared-types/dist/access.js")).href);
    const { parseRoomSessionTokenPayload, signRoomSessionToken } = await import(pathToFileURL(resolve("packages/shared-types/dist/session-token.js")).href);
    const { connectRoomState, sendSurfaceMediaAudioCommand } = await import(pathToFileURL(resolve("apps/runtime-web/dist/room-state-client.js")).href);
    const original = parseRoomSessionTokenPayload(JSON.parse(Buffer.from(originalToken.split(".")[0], "base64url").toString("utf8")));
    expect(!!original).toBe(true);
    // Only the isolated fixture issuer owns this key. An administrator MAC configures surface policy through the real socket.
    const participantId = randomUUID(), token = signRoomSessionToken({ ...original!, participantId, displayName: "Fixture administrator",
      role: "admin", roleSource: "trusted", permissions: getRoomPermissions("admin"), jti: randomUUID() }, STATE_SECRET);
    let client: ReturnType<typeof connectRoomState> | undefined, timer: ReturnType<typeof setTimeout>;
    try {
      await new Promise<void>((done, reject) => {
        timer = setTimeout(() => reject(new Error("fixture_surface_audio_timeout")), 10_000);
        client = connectRoomState(fixture.stateOrigin.replace("http:", "ws:"), roomId, participantId, {
          onOpen: () => sendSurfaceMediaAudioCommand(client!, { commandId: randomUUID(), surfaceId: "debug-main", enabled: true }),
          onRoomState: snapshot => { if (snapshot.mediaObjects.surfaces["debug-main"]?.mediaAudioEnabled) done(); },
          onError: () => reject(new Error("fixture_surface_audio_socket_failed")),
          onSurfaceCommandResult: result => { if (!result.accepted) reject(new Error("fixture_surface_audio_denied")); }
        }, token);
      });
    } finally { clearTimeout(timer!); client?.close(); }
  }
  async function activateV2() {
    expect(fixture.schema).toMatch(/^template_e2e_[0-9a-f]{32}$/);
    const { Pool } = createRequire(resolve("apps/api/package.json"))("pg");
    const pool = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL, options: `-c search_path=${fixture.schema},public` });
    try {
      const namespace = await pool.query("select current_schema() as name, 'room_identity_protocol_policy'::regclass::oid as policy");
      expect(namespace.rows[0].name).toBe(fixture.schema);
      const owner = await pool.query("select n.nspname from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.oid=$1", [namespace.rows[0].policy]);
      expect(owner.rows[0].nspname).toBe(fixture.schema);
      const { PostgresStorage } = await import(pathToFileURL(resolve("apps/api/dist/storage.js")).href);
      await new PostgresStorage(pool).identityProtocol.raise(2);
    } finally { await pool.end(); }
  }
  return { fixture, roomId, invite, admit, service, enableAudio, activateV2 };
}

test("v2 Presenter revoke retires the screen independently of UI polling, denies old sockets and preserves microphone", async ({ page, browser, request }) => {
  test.setTimeout(180_000); const h = await roomFixture(request), receiver = await browser.newPage(), runtimeViewer = await browser.newPage({ viewport: { width: 640, height: 400 } });
  const { WebSocket } = createRequire(resolve("apps/room-state/package.json"))("ws");
  const sockets: any[] = [];
  try {
    const legacy = await h.admit("member"); await h.enableAudio(legacy.state.token); await h.activateV2();
    const listening = await h.admit("member", 2);
    const mediaRoom = JSON.parse(Buffer.from(listening.token.split(".")[1], "base64url").toString("utf8")).video.room as string;
    await observer(receiver, h.fixture.origin, listening.token);
    await captureSetup(page); await page.setViewportSize({ width: 640, height: 400 });
    const actor = await h.invite("member");
    const admission = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tokens/state" && response.status() === 200);
    await page.goto(`${actor.inviteLink}&debug=1&audiomock=1&onboard=0`);
    const proof = await (await admission).json();
    expect(String(proof.token).startsWith("rs2.")).toBe(true);
    const viewerInvite = await h.invite("member");
    await runtimeViewer.goto(`${viewerInvite.inviteLink}&debug=1&audiomock=1&onboard=0`);
    await expect.poll(() => runtimeViewer.evaluate(() => (window as any).__VRATA_DEBUG__?.audioState), { timeout: 30_000 }).toBe("connected-passive");
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.audioState), { timeout: 30_000 }).toBe("connected-passive");
    await page.locator("#join-audio").click(); await expect(page.locator("#toggle-mute")).toBeEnabled({ timeout: 20_000 });
    await expect.poll(() => signal(receiver, "microphone"), { timeout: 20_000 }).toBe(true);
    expect((await request.post(`${h.fixture.origin}/api/rooms/${h.roomId}/presenters/${proof.participantId}/grant`,
      { headers: { "x-vrata-admin-token": h.fixture.adminToken } })).status()).toBe(200);
    // Establish a Presenter at admission. Live v2 role UI refresh belongs to T13;
    // this case tests revoke of an already publishing Presenter without UI assistance.
    await page.reload();
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.audioState), { timeout: 30_000 }).toBe("connected-passive");
    await page.locator("#join-audio").click(); await expect(page.locator("#toggle-mute")).toBeEnabled({ timeout: 20_000 });
    await expect(page.locator("#start-share")).toBeEnabled({ timeout: 20_000 }); await page.locator("#start-share").click();
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.screenShare?.localPublishing), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => receiver.evaluate(() => (window as any).__sourceObserver.frames), { timeout: 20_000 }).toBeGreaterThan(2);
    await expect.poll(() => signal(receiver, "screen_share_audio"), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => runtimeViewer.evaluate(() => (window as any).__VRATA_DEBUG__?.screenShare?.remoteSubscribedTrackCount), { timeout: 20_000 }).toBe(1);
    await expect.poll(() => runtimeViewer.evaluate(target => {
      const debug = (window as any).__VRATA_DEBUG__;
      const source = debug?.spatialAudio?.remoteSources?.find((source: any) => source.participantId === target);
      return source?.hasAudioNode === true && source.audioLevel > 0;
    }, proof.participantId), { timeout: 20_000 }).toBe(true);
    const participants = await h.service.listParticipants(mediaRoom);
    const mediaIdentity = participants.find((participant: any) => {
      try { const binding = JSON.parse(participant.attributes.vrataMediaBinding); return binding.participantId === proof.participantId && binding.scope === "ms"; } catch { return false; }
    })?.identity;
    expect(typeof mediaIdentity).toBe("string");
    const before = await h.service.getParticipant(mediaRoom, mediaIdentity);
    // A raw socket has no role UI or media cleanup. Keep the original RS2 across revoke and reconnect.
    async function rawSocket() {
      const url = new URL(h.fixture.stateOrigin.replace("http:", "ws:"));
      url.searchParams.set("roomId", h.roomId); url.searchParams.set("participantId", proof.participantId); url.searchParams.set("accessToken", proof.token);
      const socket = new WebSocket(url), messages: any[] = []; sockets.push(socket);
      socket.on("message", (raw: Buffer) => { messages.push(JSON.parse(String(raw))); });
      await once(socket, "open");
      await expect.poll(() => messages.some(message => message.type === "room_state"), { timeout: 10_000 }).toBe(true);
      return { socket, messages };
    }
    const stale = await rawSocket();
    const active = stale.messages.find(message => message.type === "room_state").room.mediaObjects.surfaces["debug-main"].activeObjectId;
    expect(!!active).toBe(true);
    await page.route("**/api/rooms/*/session-control", route => route.abort());
    expect((await request.post(`${h.fixture.origin}/api/rooms/${h.roomId}/presenters/${proof.participantId}/revoke`,
      { headers: { "x-vrata-admin-token": h.fixture.adminToken } })).status()).toBe(200);
    await expect.poll(() => stale.messages.some(message => message.type === "room_state"
      && message.room.participants.some((participant: any) => participant.participantId === proof.participantId && participant.role === "member")
      && message.room.mediaObjects.surfaces["debug-main"].activeObjectId === null), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.screenShareState), { timeout: 10_000 }).toBe("stopped");
    await expect.poll(() => page.evaluate(() => (window as any).__sourceCapture.streams.length > 0
      && (window as any).__sourceCapture.streams.every((stream: MediaStream) => stream.getTracks().every(track => track.readyState === "ended"))), { timeout: 10_000 }).toBe(true);
    await expect.poll(async () => (await h.service.getParticipant(mediaRoom, mediaIdentity)).tracks.some((track: any) => track.source === 3 || track.source === 4), { timeout: 10_000 }).toBe(false);
    const after = await h.service.getParticipant(mediaRoom, mediaIdentity);
    expect(after.sid === before.sid).toBe(true); expect(after.tracks.some((track: any) => track.source === 2 && !track.muted)).toBe(true);
    await expect.poll(() => signal(receiver, "microphone"), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => runtimeViewer.evaluate(() => (window as any).__VRATA_DEBUG__?.screenShare?.remoteSubscribedTrackCount), { timeout: 10_000 }).toBe(0);
    for (const connection of [stale, await rawSocket()]) {
      const commandId = randomUUID();
      connection.socket.send(JSON.stringify({ type: "surface_create_object", commandId, surfaceId: "debug-main", objectType: "screen-share", probeOnly: false }));
      await expect.poll(() => connection.messages.some(message => message.type === "access_denied" && message.result.commandId === commandId
        && !message.result.accepted && message.result.blockedReason === "missing-permission"), { timeout: 10_000 }).toBe(true);
      const patchId = randomUUID();
      connection.socket.send(JSON.stringify({ type: "surface_patch_object_state", commandId: patchId, surfaceId: "debug-main", objectId: active, expectedRevision: 1, patch: { type: "mark-active", mediaTrackSid: "stale" } }));
      await expect.poll(() => connection.messages.some(message => message.type === "access_denied" && message.result.commandId === patchId && !message.result.accepted), { timeout: 10_000 }).toBe(true);
    }
  } finally {
    for (const socket of sockets) socket.terminate();
    await Promise.allSettled([page.goto("about:blank"), receiver.close(), runtimeViewer.close()]); await h.fixture.close();
  }
});

test("fresh Member sources are enforced by self-hosted LiveKit even when SDK permission checks are bypassed", async ({ page, request }) => {
  test.setTimeout(180_000); const h = await roomFixture(request);
  try {
    const member = await h.admit("member");
    // Calibrate against the former broad grant: a camera source really publishes on this same pinned server.
    const wide = new AccessToken("devkey", "secret", { identity: randomUUID(), ttl: "120s" });
    wide.addGrant({ room: `vrata-${h.roomId}`, roomJoin: true, canPublish: true, canSubscribe: true });
    await observer(page, h.fixture.origin, await wide.toJwt());
    expect(await page.evaluate(async () => {
      const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 32; canvas.getContext("2d")!.fillRect(0, 0, 32, 32);
      const track = canvas.captureStream(5).getVideoTracks()[0], room = (window as any).__sourceObserver.room;
      try { await room.localParticipant.publishTrack(track, { source: "camera" }); return true; } catch { return false; }
      finally { track.stop(); await room.disconnect(); }
    })).toBe(true);
    await observer(page, h.fixture.origin, member.token);
    expect(await page.evaluate(() => (window as any).__sourceObserver.room.localParticipant.permissions.canPublishSources.length)).toBe(1);
    const attempt = (source: string) => page.evaluate(async source => {
      const L = (window as any).LivekitClient, room = (window as any).__sourceObserver.room;
      const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 32;
      canvas.getContext("2d")!.fillRect(0, 0, 32, 32); const track = canvas.captureStream(5).getVideoTracks()[0];
      const permissions = room.localParticipant.permissions, saved = permissions.canPublishSources; permissions.canPublishSources = [];
      try { await room.localParticipant.publishTrack(track, { source }); return true; }
      catch { return false; }
      finally { permissions.canPublishSources = saved; track.stop(); }
    }, source);
    expect(await attempt("camera")).toBe(false);
    await page.evaluate(() => (window as any).__sourceObserver.room.disconnect());
    await observer(page, h.fixture.origin, member.token);
    expect(await attempt("screen_share")).toBe(false);
    const participants = await h.service.listParticipants(`vrata-${h.roomId}`);
    expect(participants.some((participant: any) => participant.tracks.some((track: any) => track.type === 1))).toBe(false);
  } finally { await page.goto("about:blank"); await h.fixture.close(); }
});

test("v2 overlapping source classes play one remote microphone without self echo or late-source cleanup", async ({ page, browser, request }) => {
  test.setTimeout(180_000);
  const h = await roomFixture(request), viewer = await browser.newPage({ viewport: { width: 640, height: 400 } }), oldClass = await browser.newPage();
  const pageErrors: string[] = [];
  viewer.on("pageerror", error => {
    if (pageErrors.length < 16) pageErrors.push(["Error", "TypeError", "RangeError", "ReferenceError", "DOMException"].includes(error.name) ? error.name : "OtherError");
  });
  try {
    await viewer.addInitScript(() => {
      const Native = window.RTCPeerConnection, events: Array<{ pc: RTCPeerConnection; event: RTCTrackEvent }> = [];
      (window as any).__mappedTrackEvents = events;
      window.RTCPeerConnection = new Proxy(Native, { construct(target, args, newTarget) {
        const pc = Reflect.construct(target, args, newTarget) as RTCPeerConnection;
        pc.addEventListener("track", event => { if (event.track.kind === "audio") events.push({ pc, event }); });
        return pc;
      } });
    });
    await h.activateV2();
    const invitation = await h.invite("host");
    const admission = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tokens/state" && response.status() === 200);
    await page.setViewportSize({ width: 640, height: 400 });
    await page.goto(`${invitation.inviteLink}&debug=1&audiomock=1&onboard=0`);
    const proof = await (await admission).json();
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.audioState), { timeout: 30_000 }).toBe("connected-passive");
    await page.locator("#join-audio").click();
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.media?.publishedAudio), { timeout: 20_000 }).toBe(true);
    const viewerInvite = await h.invite("member");
    await viewer.goto(`${viewerInvite.inviteLink}&debug=1&audiomock=1&onboard=0`);
    try {
      await expect.poll(() => viewer.evaluate(() => (window as any).__VRATA_DEBUG__?.media?.subscribedAudioCount), { timeout: 30_000 }).toBe(1);
    } catch {
      const states = await Promise.all([page, viewer].map(client => client.evaluate(target => {
        const d = (window as any).__VRATA_DEBUG__, peer = d?.remoteParticipants?.find((p: any) => p.participantId === target);
        return { scene: d?.sceneBundleState, connected: d?.roomStateConnected, audio: d?.audioState,
          issue: d?.issueCode, joined: d?.media?.audioJoined, published: d?.media?.publishedAudio,
          subscriptions: d?.media?.subscribedAudioCount, peerSeen: !!peer, peerActive: peer?.activeAudio,
          peerMuted: peer?.muted, peerHasNode: peer?.hasAudioNode,
          visibility: document.visibilityState,
          presenceAgeMs: typeof d?.lastPresenceSyncAt === "number" ? Date.now() - d.lastPresenceSyncAt : null,
          receivedTrackEvents: (window as any).__mappedTrackEvents?.length ?? null };
      }, proof.participantId)));
      const mediaRoom = (await h.service.listRooms()).find((room: any) => room.name.endsWith(`:${h.roomId}`))?.name;
      const { verifyUserMediaIdentity } = await import(pathToFileURL(resolve("packages/shared-types/dist/media-identity.js")).href);
      const peers = await Promise.all((mediaRoom ? await h.service.listParticipants(mediaRoom) : []).map(async (peer: any) => ({
        tracks: peer.tracks.map((track: any) => ({ source: track.source, muted: track.muted })),
        bindingPresent: typeof peer.attributes.vrataMediaBinding === "string",
        bindingVerifies: !!await verifyUserMediaIdentity(mediaRoom, peer.identity, peer.attributes)
      })));
      throw new Error(`overlap_microphone_not_ready:${JSON.stringify({ states, peers, pageErrors })}`);
    }
    const response = await request.post(`${h.fixture.origin}/api/tokens/media`, {
      headers: { authorization: `Bearer ${proof.token}` }, data: { roomId: h.roomId, participantId: proof.participantId, canPublishAudio: true, canPublishVideo: false }
    });
    expect(response.status()).toBe(200);
    const token = (await response.json()).token;
    await observer(oldClass, h.fixture.origin, token);
    await oldClass.evaluate(async () => {
      const context = new AudioContext(), oscillator = context.createOscillator(), gain = context.createGain(), sink = context.createMediaStreamDestination();
      oscillator.frequency.value = 880; gain.gain.value = 0.05; oscillator.connect(gain).connect(sink); oscillator.start(); await context.resume();
      await (window as any).__sourceObserver.room.localParticipant.publishTrack(sink.stream.getAudioTracks()[0], { source: "microphone" });
    });
    const mediaRoom = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).video.room;
    const ownScopes = (await h.service.listParticipants(mediaRoom)).filter((peer: any) => {
      try { return JSON.parse(peer.attributes.vrataMediaBinding).participantId === proof.participantId; } catch { return false; }
    });
    expect(ownScopes.length).toBe(2);
    const combinedSid = ownScopes.find((peer: any) => JSON.parse(peer.attributes.vrataMediaBinding).scope === "ms")?.sid;
    expect(typeof combinedSid).toBe("string");
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.media?.subscribedAudioCount), { timeout: 10_000 }).toBe(0);
    expect(await viewer.evaluate(() => (window as any).__VRATA_DEBUG__?.media?.subscribedAudioCount)).toBe(1);
    const receive = () => viewer.evaluate(async () => {
      const element = Array.from(document.querySelectorAll("audio")).find(element => element.srcObject instanceof MediaStream);
      if (!element || !(element.srcObject instanceof MediaStream)) return null;
      const root = window as any;
      let probe = root.__mappedAudioProbe;
      const track = element.srcObject.getAudioTracks()[0];
      if (!track) return null;
      if (probe?.track !== track) {
        await probe?.context.close();
        const context = new AudioContext(), analyser = context.createAnalyser(); analyser.fftSize = 1024;
        context.createMediaStreamSource(new MediaStream([track])).connect(analyser); await context.resume();
        probe = root.__mappedAudioProbe = { context, analyser, track };
      }
      const samples = new Uint8Array(probe.analyser.fftSize); probe.analyser.getByteTimeDomainData(samples);
      return samples.some(sample => Math.abs(sample - 128) > 2);
    });
    await expect.poll(receive, { timeout: 15_000 }).toBe(true);
    // Replay the genuine ontrack through the SDK: same publication SID/native ID, new SDK Track object.
    expect(await viewer.evaluate(expectedParticipantSid => {
      const root = window as any;
      const element = Array.from(document.querySelectorAll("audio")).find(element => element.srcObject instanceof MediaStream);
      const track = (element?.srcObject as MediaStream | undefined)?.getAudioTracks()[0];
      const sample = root.__mappedTrackEvents.find((sample: { event: RTCTrackEvent }) => sample.event.track === track);
      if (!sample || !element || !sample.event.streams.some((stream: MediaStream) => stream.id.split("|")[0] === expectedParticipantSid)) return false;
      root.__mappedPreviousAudioElement = element;
      const event = sample.event as RTCTrackEvent;
      sample.pc.dispatchEvent(new RTCTrackEvent("track", { receiver: event.receiver, track: event.track,
        streams: [...event.streams], transceiver: event.transceiver }));
      return true;
    }, combinedSid)).toBe(true);
    await expect.poll(() => viewer.evaluate(() => {
      const previous = (window as any).__mappedPreviousAudioElement as HTMLAudioElement;
      return !previous.isConnected && Array.from(document.querySelectorAll("audio")).some(element =>
        element !== previous && element.srcObject instanceof MediaStream);
    }), { timeout: 10_000 }).toBe(true);
    await expect.poll(receive, { timeout: 10_000 }).toBe(true);
    await oldClass.evaluate(() => (window as any).__sourceObserver.room.disconnect());
    await expect.poll(async () => (await h.service.listParticipants(mediaRoom)).filter((peer: any) => {
      try { return JSON.parse(peer.attributes.vrataMediaBinding).participantId === proof.participantId; } catch { return false; }
    }).length, { timeout: 10_000 }).toBe(1);
    expect(await viewer.evaluate(() => (window as any).__VRATA_DEBUG__?.media?.subscribedAudioCount)).toBe(1);
    await expect.poll(receive, { timeout: 10_000 }).toBe(true);
    await page.locator("#toggle-mute").click();
    await expect.poll(() => viewer.evaluate(() => (window as any).__VRATA_DEBUG__?.media?.subscribedAudioCount), { timeout: 10_000 }).toBe(0);
    await page.locator("#toggle-mute").click();
    await expect.poll(() => viewer.evaluate(() => (window as any).__VRATA_DEBUG__?.media?.subscribedAudioCount), { timeout: 10_000 }).toBe(1);
    await expect.poll(receive, { timeout: 10_000 }).toBe(true);
  } finally {
    await Promise.allSettled([page.goto("about:blank"), viewer.close(), oldClass.close()]); await h.fixture.close();
  }
});

for (const mode of ["host", "promotion-live", "promotion-muted", "promotion-denied", "promotion-unavailable"] as const) {
  test(`main runtime scoped media: ${mode}`, async ({ page, browser, request }) => {
    test.setTimeout(180_000); const h = await roomFixture(request), receiver = await browser.newPage();
    let requests = 0, captureBeforeUpgrade = false;
    const replies: Array<{ status: number; endpointMatches: boolean; sources: string[] }> = [];
    const errors = { permission: 0, signal: 0, transport: 0, other: 0 };
    page.on("console", message => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (/permission|forbidden/i.test(text)) errors.permission++;
      else if (/signal|auth|token/i.test(text)) errors.signal++;
      else if (/ice|peer|connection/i.test(text)) errors.transport++;
      else errors.other++;
    });
    page.on("response", async response => {
      if (new URL(response.url()).pathname !== "/api/tokens/media") return;
      try {
        const body = await response.json();
        const grant = typeof body.token === "string" ? JSON.parse(Buffer.from(body.token.split(".")[1], "base64url").toString("utf8")).video : null;
        const sources = Array.isArray(grant?.canPublishSources) ? grant.canPublishSources.map((source: unknown) =>
          ["microphone", "screen_share", "screen_share_audio"].includes(String(source)) ? String(source) : "other").slice(0, 4) : [];
        if (replies.length < 8) replies.push({ status: response.status(), endpointMatches: body.livekitUrl === livekit.url, sources });
      } catch { /* no credentials or raw errors retained */ }
    });
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/tokens/media") requests++; });
    try {
      const listening = await h.admit("member"); await observer(receiver, h.fixture.origin, listening.token);
      await captureSetup(page);
      await page.setViewportSize({ width: 640, height: 400 });
      const actor = await h.invite(mode === "host" ? "host" : "member");
      try { await page.goto(`${actor.inviteLink}&debug=1&audiomock=1&onboard=0`); }
      catch { throw new Error("media_runtime_navigation_failed"); }
      await page.bringToFront();
      await expect.poll(() => page.evaluate(() => document.visibilityState), { timeout: 10_000 }).toBe("visible");
      await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected), { timeout: 20_000 }).toBe(true);
      // This scenario starts from a connected subscriber, then verifies microphone join and share/promotion. DOM enabled
      // alone predates scene boot and the initial SDK handshake; it is not media readiness.
      await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.audioState), { timeout: 30_000 }).toBe("connected-passive");
      await h.enableAudio(listening.state.token);
      await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.mediaObjects?.surfaces?.find((surface: any) => surface.surfaceId === "debug-main")?.mediaAudioEnabled), { timeout: 10_000 }).toBe(true);
      await expect(page.locator("#join-audio")).toBeEnabled({ timeout: 20_000 });
      if (mode === "promotion-muted") await page.locator("#join-muted").check();
      await page.locator("#join-audio").click();
      expect(await page.evaluate(() => (window as any).__sourceJoinClicks)).toBe(1);
      await expect(page.locator("#toggle-mute")).toBeEnabled({ timeout: 20_000 });
      const participantId = await page.evaluate(() => (window as any).__VRATA_DEBUG__.participantId) as string;
      const before = await h.service.getParticipant(`vrata-${h.roomId}`, participantId);
      const initialRequests = requests;
      if (mode !== "promotion-muted") await expect.poll(() => signal(receiver, "microphone"), { timeout: 20_000 }).toBe(true);
      if (mode !== "host") {
        expect((await request.post(`${h.fixture.origin}/api/rooms/${h.roomId}/presenters/${participantId}/grant`,
          { headers: { "x-vrata-admin-token": h.fixture.adminToken } })).status()).toBe(200);
        await expect(page.locator("#start-share")).toBeEnabled({ timeout: 20_000 });
        await page.route("**/api/tokens/media", async route => {
          captureBeforeUpgrade = await page.evaluate(() => (window as any).__sourceCapture.starts > 0);
          if (mode === "promotion-denied") await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden", reason: "media_publish_not_allowed" }) });
          else await route.continue();
        });
      }
      if (mode === "promotion-unavailable") await page.evaluate(() => { (window as any).__sourceCapture.hold = true; });
      await page.locator("#start-share").click();
      if (mode === "promotion-unavailable") {
        await expect.poll(() => page.evaluate(() => (window as any).__sourceCapture.starts), { timeout: 10_000 }).toBe(1);
        await page.locator("#media-surface-select").selectOption("whiteboard-wall");
        await expect(page.locator("#start-share")).toBeDisabled();
        await page.evaluate(() => { (window as any).__sourceCapture.release(); });
      }
      if (mode === "promotion-denied" || mode === "promotion-unavailable") {
        await expect.poll(() => page.evaluate(() => (window as any).__sourceCapture.streams.length > 0
          && (window as any).__sourceCapture.streams.every((stream: MediaStream) => stream.getTracks().every(track => track.readyState === "ended"))), { timeout: 20_000 }).toBe(true);
        expect((await h.service.getParticipant(`vrata-${h.roomId}`, participantId)).sid === before.sid).toBe(true);
        await expect.poll(() => signal(receiver, "microphone"), { timeout: 20_000 }).toBe(true);
      } else {
        await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__.screenShare.localPublishing), { timeout: 30_000 }).toBe(true);
        await expect.poll(() => receiver.evaluate(() => (window as any).__sourceObserver.frames), { timeout: 20_000 }).toBeGreaterThan(2);
        await expect.poll(() => signal(receiver, "screen_share_audio"), { timeout: 20_000 }).toBe(true);
        const after = await h.service.getParticipant(`vrata-${h.roomId}`, participantId);
        expect(after.sid === before.sid).toBe(mode === "host");
        expect(after.tracks.some((track: any) => track.source === 2 && !track.muted)).toBe(mode !== "promotion-muted");
        if (mode === "promotion-muted") {
          await expect(page.locator("#toggle-mute")).toHaveText("Unmute");
          expect(after.tracks.some((track: any) => track.source === 2 && !track.muted)).toBe(false);
          await page.locator("#toggle-mute").click();
        }
        await expect.poll(() => signal(receiver, "microphone"), { timeout: 20_000 }).toBe(true);
      }
      expect(requests - initialRequests).toBe(mode === "host" || mode === "promotion-unavailable" ? 0 : 1);
      if (mode !== "host" && mode !== "promotion-unavailable") expect(captureBeforeUpgrade).toBe(true);
    } catch (error) {
      const state = await page.evaluate(() => {
        const debug = (window as any).__VRATA_DEBUG__, query = new URL(location.href).searchParams;
        const audioStates = ["connected", "connected-passive", "live", "muted", "joining", "not_joined", "degraded", "disabled", "unsupported", "remote-track"];
        const actions = ["audio_join_failed", "media_passive_connect_failed", "microphone_track_ended", "microphone_restore_failed"];
        return { debugMode: query.get("debug") === "1", audioMock: query.get("audiomock") === "1",
          visible: document.visibilityState === "visible",
          joinClicks: Number.isSafeInteger((window as any).__sourceJoinClicks) ? (window as any).__sourceJoinClicks : null,
          audioState: audioStates.includes(debug?.audioState) ? debug.audioState : "other",
          lastAction: actions.includes(debug?.lastRecoveryAction) ? debug.lastRecoveryAction : "other",
          joined: debug?.media?.audioJoined === true, published: debug?.media?.publishedAudio === true,
          host: debug?.access?.role === "host", gateVisible: !!document.getElementById("session-upgrade-dialog")?.getBoundingClientRect().width };
      }).catch(() => null);
      await test.info().attach("scoped-media-state", { body: JSON.stringify({ state, replies, errors }), contentType: "application/json" });
      throw error;
    } finally {
      await Promise.allSettled([page.goto("about:blank"), receiver.close()]); await h.fixture.close();
    }
  });
}
