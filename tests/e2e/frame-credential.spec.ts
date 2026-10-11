import { expect, test, type Frame, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  decodeRemoteBrowserFrameToken, isRemoteBrowserFrameBinding, type RemoteBrowserFrameBinding
} from "../../packages/shared-types/src/remote-browser-frame-token.js";
import { parseRoomSessionTokenPayload, signRoomSessionToken, type RoomSessionTokenPayload } from "../../packages/shared-types/src/session-token.js";

// Local only: real API -> room-state -> remote-browser frame transport without the runtime UI or WebGL. Credentials,
// URLs, SDP and message bodies stay in test memory; assertions compare scalars only. Never tagged for staging.
test.use({ trace: "off", screenshot: "off", video: "off" });

const { WebSocket: NodeWebSocket } = createRequire(resolve("apps/remote-browser/package.json"))("ws");
type NodeSocket = InstanceType<typeof NodeWebSocket>;

// The local services inherit these; the defaults are the non-production fallbacks both services use.
const stateTokenSecret = process.env.STATE_TOKEN_SECRET ?? "dev-state-secret";
const frameTokenSecret = process.env.REMOTE_BROWSER_TOKEN_SECRET?.trim() || "dev-remote-browser-secret";
const shortProofSeconds = 7;
const expiredCloseReason = "frame_token_expired";

interface RemoteBrowserWireState { status?: unknown; executorSessionId?: unknown; executorInstanceId?: unknown; frameStreamId?: unknown }
interface WireObject { type?: unknown; revision?: unknown; state?: RemoteBrowserWireState }
interface CommandResult { accepted: boolean; objectId: string | null; blockedReason: string | null }
interface FrameCredential { status: number; token: string | null; expiresInSeconds: number | null; frameStreamUrl: string | null; error: string | null }
interface FrameProbe {
  opened: Promise<boolean>;
  closed: Promise<{ code: number; reason: string; atMs: number }>;
  frameCount: () => number;
  writeRaw: (bytes: Buffer) => boolean;
}
interface FrameSockets { connect: (url: string) => FrameProbe; dispose: () => void }
interface HostRoom {
  readonly roomId: string;
  readonly sessionToken: string;
  readonly proof: RoomSessionTokenPayload;
  readonly frames: FrameSockets;
  object: (objectId: string) => WireObject | undefined;
  command: (message: Record<string, unknown>) => Promise<CommandResult>;
  dispose: () => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, Math.max(0, ms)));
const demoUrl = (baseURL: string) => new URL("/remote-browser-demo.html", baseURL).toString();

async function settle<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<null>(done => { timer = setTimeout(() => done(null), Math.max(0, timeoutMs)); })]);
  } finally {
    clearTimeout(timer);
  }
}

function frameSockets(): FrameSockets {
  const owned = new Set<NodeSocket>();
  return {
    connect(url) {
      const socket: NodeSocket = new NodeWebSocket(url);
      owned.add(socket);
      let frames = 0;
      socket.on("message", (raw: Buffer) => {
        try {
          const message = JSON.parse(String(raw)) as { type?: unknown; dataUrl?: unknown };
          if (message.type === "frame" && typeof message.dataUrl === "string" && message.dataUrl.startsWith("data:image/")) frames += 1;
        } catch { /* only the frame count is kept */ }
      });
      // A refused upgrade surfaces as an error followed by close; only the outcome is kept.
      socket.on("error", () => undefined);
      const closed = new Promise<{ code: number; reason: string; atMs: number }>(done => {
        socket.once("close", (code: number, reason: Buffer) => { owned.delete(socket); done({ code, reason: reason.toString("utf8"), atMs: Date.now() }); });
      });
      const opened = new Promise<boolean>(done => { socket.once("open", () => done(true)); socket.once("close", () => done(false)); });
      // Writes onto this test-owned socket's transport, outside the client's own framing.
      const writeRaw = (bytes: Buffer): boolean => {
        const transport = socket._socket as { writable?: boolean; write: (chunk: Buffer) => boolean } | null | undefined;
        if (!transport?.writable) return false;
        transport.write(bytes);
        return true;
      };
      return { opened, closed, frameCount: () => frames, writeRaw };
    },
    dispose() {
      for (const socket of owned) socket.terminate();
      owned.clear();
    }
  };
}

function readProof(token: string): RoomSessionTokenPayload | null {
  try {
    return parseRoomSessionTokenPayload(JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

async function joinHostRoom(baseURL: string): Promise<HostRoom> {
  const roomId = `frame-credential-${randomUUID()}`;
  const participantId = `frame-host-${randomUUID()}`;
  const admitted = await fetch(new URL("/api/tokens/state", baseURL), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomId, participantId, displayName: "Frame credential host", requestedRole: "host" })
  });
  expect(admitted.status).toBe(200);
  const body = await admitted.json() as { token?: unknown; role?: unknown };
  expect(body.role).toBe("host");
  expect(typeof body.token).toBe("string");
  const sessionToken = body.token as string;
  const proof = readProof(sessionToken);
  expect(proof !== null && proof.roomId === roomId && proof.participantId === participantId && proof.role === "host").toBe(true);

  const address = new URL(process.env.E2E_ROOM_STATE_PUBLIC_URL!);
  address.searchParams.set("roomId", roomId);
  address.searchParams.set("participantId", participantId);
  address.searchParams.set("accessToken", sessionToken);
  const socket: NodeSocket = new NodeWebSocket(address);
  let objects: Record<string, WireObject> = {};
  let snapshots = 0;
  const results = new Map<string, CommandResult>();
  socket.on("message", (raw: Buffer) => {
    let message: {
      type?: unknown;
      room?: { mediaObjects?: { objects?: Record<string, WireObject> } } | null;
      result?: { accepted?: unknown; commandId?: unknown; objectId?: unknown; blockedReason?: unknown };
    };
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.type === "room_state" && message.room) {
      objects = message.room.mediaObjects?.objects ?? {};
      snapshots += 1;
    } else if ((message.type === "surface_command_result" || message.type === "access_denied") && typeof message.result?.commandId === "string") {
      results.set(message.result.commandId, {
        accepted: message.result.accepted === true,
        objectId: typeof message.result.objectId === "string" ? message.result.objectId : null,
        blockedReason: typeof message.result.blockedReason === "string" ? message.result.blockedReason : null
      });
    }
  });
  socket.on("error", () => undefined);
  await once(socket, "open");
  await expect.poll(() => snapshots > 0, { timeout: 10_000 }).toBe(true);

  const ownedObjects = new Set<string>();
  const frames = frameSockets();
  return {
    roomId,
    sessionToken,
    proof: proof!,
    frames,
    object: objectId => objects[objectId],
    async command(message) {
      const commandId = randomUUID();
      socket.send(JSON.stringify({ ...message, commandId }));
      await expect.poll(() => results.has(commandId), { timeout: 10_000 }).toBe(true);
      const result = results.get(commandId)!;
      if (message.type === "surface_create_object" && result.accepted && result.objectId) ownedObjects.add(result.objectId);
      return result;
    },
    async dispose() {
      frames.dispose();
      if (socket.readyState === NodeWebSocket.OPEN) {
        for (const objectId of ownedObjects) {
          const commandId = randomUUID();
          socket.send(JSON.stringify({ type: "surface_stop_object", surfaceId: "debug-main", objectId, commandId }));
          const deadline = Date.now() + 5_000;
          while (!results.has(commandId) && Date.now() < deadline) await sleep(100);
        }
      }
      if (socket.readyState !== NodeWebSocket.CLOSED) {
        const closed = once(socket, "close").catch(() => undefined);
        socket.close();
        await settle(closed, 5_000);
      }
    }
  };
}

async function createRemoteBrowser(host: HostRoom): Promise<string> {
  const created = await host.command({ type: "surface_create_object", probeOnly: false, objectType: "remote-browser", surfaceId: "debug-main" });
  expect(created.accepted).toBe(true);
  expect(typeof created.objectId).toBe("string");
  const objectId = created.objectId!;
  await expect.poll(() => host.object(objectId)?.type ?? null, { timeout: 10_000 }).toBe("remote-browser");
  return objectId;
}

// One logical open keeps its inputEventId across revision retries; a caller may pin it to reuse an earlier open's id.
async function openUrl(host: HostRoom, objectId: string, url: string, inputEventId = `frame-credential-open-${randomUUID()}`): Promise<void> {
  let accepted = false;
  for (let attempt = 0; attempt < 3 && !accepted; attempt += 1) {
    const revision = host.object(objectId)?.revision;
    expect(typeof revision).toBe("number");
    const result = await host.command({
      type: "surface_patch_object_state",
      surfaceId: "debug-main",
      objectId,
      expectedRevision: revision,
      patch: { type: "open-url", url, inputEventId }
    });
    accepted = result.accepted;
    // Executor callbacks may advance the revision between snapshot and command; only that refusal is retried.
    if (!accepted) expect(result.blockedReason).toBe("revision-mismatch");
  }
  expect(accepted).toBe(true);
}

async function waitForActiveBinding(host: HostRoom, objectId: string, replacing?: string): Promise<RemoteBrowserFrameBinding> {
  await expect.poll(() => {
    const state = host.object(objectId)?.state;
    return {
      active: state?.status === "active",
      current: typeof state?.executorInstanceId === "string" && state.executorInstanceId !== replacing
    };
  }, { timeout: 30_000, intervals: [250, 500, 1000] }).toEqual({ active: true, current: true });
  const state = host.object(objectId)!.state!;
  const executorSessionId = String(state.executorSessionId);
  // The wire snapshot is the only binding source. Room-state does not publish frameStreamId (keeping the runtime
  // frame fallback inactive); the shared codec admits exactly one stream id per executor session.
  const binding = {
    roomId: host.roomId,
    objectId,
    executorSessionId,
    executorInstanceId: String(state.executorInstanceId),
    frameStreamId: typeof state.frameStreamId === "string" ? state.frameStreamId : `${executorSessionId}:frames`
  };
  expect(isRemoteBrowserFrameBinding(binding)).toBe(true);
  return binding;
}

async function requestFrameCredential(baseURL: string, bearer: string, binding: RemoteBrowserFrameBinding): Promise<FrameCredential> {
  const response = await fetch(new URL("/api/tokens/remote-browser-frame", baseURL), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify(binding)
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  return {
    status: response.status,
    token: typeof body?.token === "string" ? body.token : null,
    expiresInSeconds: typeof body?.expiresInSeconds === "number" ? body.expiresInSeconds : null,
    frameStreamUrl: typeof body?.frameStreamUrl === "string" ? body.frameStreamUrl : null,
    error: typeof body?.error === "string" ? body.error : null
  };
}

async function startActiveExecutor(host: HostRoom, baseURL: string) {
  const objectId = await createRemoteBrowser(host);
  await openUrl(host, objectId, demoUrl(baseURL));
  return { objectId, binding: await waitForActiveBinding(host, objectId) };
}

async function expectStreaming(host: HostRoom, credential: FrameCredential): Promise<FrameProbe> {
  const viewer = host.frames.connect(credential.frameStreamUrl!);
  expect(await settle(viewer.opened, 10_000)).toBe(true);
  await expect.poll(() => viewer.frameCount() > 0, { timeout: 15_000 }).toBe(true);
  return viewer;
}

test("an issued codec-2 frame credential streams frames from the active executor", async ({ baseURL }) => {
  test.setTimeout(60_000);
  const host = await joinHostRoom(baseURL!);
  try {
    const { binding } = await startActiveExecutor(host, baseURL!);
    const issuedAtSeconds = Math.floor(Date.now() / 1000);
    const issued = await requestFrameCredential(baseURL!, host.sessionToken, binding);
    expect(issued.status).toBe(200);
    const claims = decodeRemoteBrowserFrameToken(issued.token, frameTokenSecret);
    expect({
      decoded: claims !== null,
      bindingMatches: claims !== null && claims.roomId === binding.roomId && claims.objectId === binding.objectId
        && claims.executorSessionId === binding.executorSessionId && claims.executorInstanceId === binding.executorInstanceId
        && claims.frameStreamId === binding.frameStreamId,
      lifetimeReported: claims !== null && issued.expiresInSeconds !== null
        && Math.abs(claims.exp - issuedAtSeconds - issued.expiresInSeconds) <= 1,
      urlCarriesToken: issued.frameStreamUrl !== null && new URL(issued.frameStreamUrl).searchParams.get("token") === issued.token
    }).toEqual({ decoded: true, bindingMatches: true, lifetimeReported: true, urlCarriesToken: true });
    await expectStreaming(host, issued);
  } finally {
    await host.dispose();
  }
});

test("a replacement executor instance closes the old frame socket and refuses its unexpired credential", async ({ baseURL }) => {
  test.setTimeout(60_000);
  const host = await joinHostRoom(baseURL!);
  try {
    const { objectId, binding: first } = await startActiveExecutor(host, baseURL!);
    const firstIssued = await requestFrameCredential(baseURL!, host.sessionToken, first);
    expect(firstIssued.status).toBe(200);
    const firstViewer = await expectStreaming(host, firstIssued);

    await openUrl(host, objectId, demoUrl(baseURL!));
    const second = await waitForActiveBinding(host, objectId, first.executorInstanceId);
    expect({
      sameSession: second.executorSessionId === first.executorSessionId,
      newInstance: second.executorInstanceId !== first.executorInstanceId
    }).toEqual({ sameSession: true, newInstance: true });
    expect(await settle(firstViewer.closed, 15_000) !== null).toBe(true);

    // Still inside its own lifetime, so a refusal can only come from the consumer's instance pin.
    expect(decodeRemoteBrowserFrameToken(firstIssued.token, frameTokenSecret) !== null).toBe(true);
    const replay = host.frames.connect(firstIssued.frameStreamUrl!);
    expect(await settle(replay.opened, 10_000)).toBe(false);

    const secondIssued = await requestFrameCredential(baseURL!, host.sessionToken, second);
    expect(secondIssued.status).toBe(200);
    await expectStreaming(host, secondIssued);
  } finally {
    await host.dispose();
  }
});

test("the issuer refuses a frame credential for a superseded executor instance", async ({ baseURL }) => {
  test.setTimeout(60_000);
  const host = await joinHostRoom(baseURL!);
  try {
    const { objectId, binding: first } = await startActiveExecutor(host, baseURL!);
    await openUrl(host, objectId, demoUrl(baseURL!));
    const second = await waitForActiveBinding(host, objectId, first.executorInstanceId);

    const stale = await requestFrameCredential(baseURL!, host.sessionToken, first);
    expect({ status: stale.status, error: stale.error, signed: stale.token !== null })
      .toEqual({ status: 409, error: "remote_browser_session_not_authoritative", signed: false });
    const current = await requestFrameCredential(baseURL!, host.sessionToken, second);
    expect(current.status).toBe(200);
  } finally {
    await host.dispose();
  }
});

test("reopening with an earlier open's input event id binds a fresh executor instance that refuses the first credential", async ({ baseURL }) => {
  test.setTimeout(90_000);
  const host = await joinHostRoom(baseURL!);
  try {
    const objectId = await createRemoteBrowser(host);
    const reusedInputEventId = `frame-credential-open-${randomUUID()}`;
    await openUrl(host, objectId, demoUrl(baseURL!), reusedInputEventId);
    const first = await waitForActiveBinding(host, objectId);
    const firstIssued = await requestFrameCredential(baseURL!, host.sessionToken, first);
    expect(firstIssued.status).toBe(200);

    await openUrl(host, objectId, demoUrl(baseURL!));
    const second = await waitForActiveBinding(host, objectId, first.executorInstanceId);
    await openUrl(host, objectId, demoUrl(baseURL!), reusedInputEventId);
    const third = await waitForActiveBinding(host, objectId, second.executorInstanceId);
    expect({
      sameSession: second.executorSessionId === first.executorSessionId && third.executorSessionId === first.executorSessionId,
      secondFresh: second.executorInstanceId !== first.executorInstanceId,
      thirdNotFirst: third.executorInstanceId !== first.executorInstanceId,
      thirdNotSecond: third.executorInstanceId !== second.executorInstanceId
    }).toEqual({ sameSession: true, secondFresh: true, thirdNotFirst: true, thirdNotSecond: true });

    // Still inside its own lifetime, so a refusal can only come from the consumer's instance pin.
    expect(decodeRemoteBrowserFrameToken(firstIssued.token, frameTokenSecret) !== null).toBe(true);
    const replay = host.frames.connect(firstIssued.frameStreamUrl!);
    expect(await settle(replay.opened, 10_000)).toBe(false);
    const stale = await requestFrameCredential(baseURL!, host.sessionToken, first);
    expect({ status: stale.status, error: stale.error, signed: stale.token !== null })
      .toEqual({ status: 409, error: "remote_browser_session_not_authoritative", signed: false });

    const current = await requestFrameCredential(baseURL!, host.sessionToken, third);
    expect(current.status).toBe(200);
    await expectStreaming(host, current);
  } finally {
    await host.dispose();
  }
});

test("a short original proof clips the frame lease and the socket closes at that deadline", async ({ baseURL }) => {
  test.setTimeout(60_000);
  const host = await joinHostRoom(baseURL!);
  try {
    const { binding } = await startActiveExecutor(host, baseURL!);
    // Signed only after the executor is active so startup cannot consume the short lease. This clones the issued v1
    // payload and changes only exp, under the local fixture key; it never adds claims.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const proofExp = nowSeconds + shortProofSeconds;
    expect(host.proof.iat <= nowSeconds && host.proof.exp > proofExp).toBe(true);
    const shortProof = signRoomSessionToken({ ...host.proof, exp: proofExp }, stateTokenSecret);

    const issued = await requestFrameCredential(baseURL!, shortProof, binding);
    expect(issued.status).toBe(200);
    const claims = decodeRemoteBrowserFrameToken(issued.token, frameTokenSecret);
    expect({
      decoded: claims !== null,
      clipped: claims !== null && claims.exp <= proofExp,
      reportedWithinProof: issued.expiresInSeconds !== null && issued.expiresInSeconds > 0 && issued.expiresInSeconds <= shortProofSeconds
    }).toEqual({ decoded: true, clipped: true, reportedWithinProof: true });

    const deadlineMs = claims!.exp * 1000;
    const viewer = host.frames.connect(issued.frameStreamUrl!);
    expect(await settle(viewer.opened, 5_000)).toBe(true);
    await expect.poll(() => viewer.frameCount() > 0, { timeout: Math.max(1_000, deadlineMs - Date.now()) }).toBe(true);
    const closed = await settle(viewer.closed, deadlineMs - Date.now() + 5_000);
    expect({
      closed: closed !== null,
      code: closed?.code ?? null,
      reason: closed?.reason ?? null,
      notBeforeDeadline: closed !== null && closed.atMs >= deadlineMs - 100,
      nearDeadline: closed !== null && closed.atMs <= deadlineMs + 3_000
    }).toEqual({ closed: true, code: 1008, reason: expiredCloseReason, notBeforeDeadline: true, nearDeadline: true });

    const retry = host.frames.connect(issued.frameStreamUrl!);
    expect(await settle(retry.opened, 10_000)).toBe(false);
  } finally {
    await host.dispose();
  }
});

test("a protocol-violating frame socket is retired alone; the consumer stays ready and other viewers keep streaming", async ({ baseURL }) => {
  test.setTimeout(90_000);
  const host = await joinHostRoom(baseURL!);
  try {
    const { objectId, binding } = await startActiveExecutor(host, baseURL!);
    const issued = await requestFrameCredential(baseURL!, host.sessionToken, binding);
    expect(issued.status).toBe(200);
    const viewer = await expectStreaming(host, issued);
    const rogue = host.frames.connect(issued.frameStreamUrl!);
    expect(await settle(rogue.opened, 10_000)).toBe(true);

    // An unmasked client text frame: the consumer's ws receiver raises a protocol error before any message event.
    expect(rogue.writeRaw(Buffer.from([0x81, 0x00]))).toBe(true);
    expect(await settle(rogue.closed, 10_000) !== null).toBe(true);

    const framesAfterRetire = viewer.frameCount();
    await expect.poll(() => viewer.frameCount() > framesAfterRetire, { timeout: 15_000 }).toBe(true);
    // The consumer that served this credential; resolving the path drops the token query.
    const readiness = new URL("/health/ready", issued.frameStreamUrl!);
    readiness.protocol = readiness.protocol === "wss:" ? "https:" : "http:";
    const ready = await fetch(readiness);
    const body = await ready.json().catch(() => null) as { status?: unknown } | null;
    const state = host.object(objectId)?.state;
    expect({
      status: ready.status,
      ready: body?.status === "ready",
      viewerOpen: await settle(viewer.closed, 0) === null,
      active: state?.status === "active",
      sameExecutor: state?.executorInstanceId === binding.executorInstanceId
    }).toEqual({ status: 200, ready: true, viewerOpen: true, active: true, sameExecutor: true });

    const reissued = await requestFrameCredential(baseURL!, host.sessionToken, binding);
    expect(reissued.status).toBe(200);
    await expectStreaming(host, reissued);
  } finally {
    await host.dispose();
  }
});

// Browser peer lease. These evaluate the exact built production page functions in real Chromium; nothing here
// re-implements them. Only the source frame's RTCPeerConnection.prototype.setRemoteDescription is patched, to track
// and gate peers.
interface FrameMediaAnswerInput { offer: RTCSessionDescriptionInit; iceServers: RTCIceServer[]; nonce: string; expiresAtMs: number }
interface FrameMediaPeerModule {
  remoteBrowserCreateMediaAnswerInPage: (input: FrameMediaAnswerInput) => Promise<{ ok?: unknown; answer?: unknown }>;
  remoteBrowserCloseMediaPeerInPage: (nonce: string) => boolean;
}
type PeerHarness = {
  pcs: RTCPeerConnection[];
  gate: Promise<void> | null;
  release: (() => void) | null;
  gateHit: boolean;
  video: HTMLVideoElement;
  restore: () => void;
};
type PeerWindow = Window & {
  __frameCredentialPeerTest?: PeerHarness;
  /** Top page only: the original canvas stream and its draw timer. */
  __frameCredentialSource?: { stream: MediaStream; timer: number };
  __frameCredentialReceivers?: RTCPeerConnection[];
  /** The production per-frame slot, read only. */
  __VRATA_REMOTE_BROWSER_MEDIA__?: { pc?: RTCPeerConnection; peerNonce?: string; expiryTimer?: number };
};

const framePeerModulePath = resolve("apps/remote-browser/dist/frame-media-page.js");
const noAnswer = { ok: false, hasAnswer: false };
const summarizeAnswer = (result: { ok?: unknown; answer?: unknown } | null | undefined) => ({ ok: result?.ok === true, hasAnswer: Boolean(result?.answer) });

async function loadFramePeer(): Promise<FrameMediaPeerModule> {
  expect(existsSync(framePeerModulePath)).toBe(true);
  const loaded = await import(pathToFileURL(framePeerModulePath).href) as Partial<FrameMediaPeerModule>;
  expect(typeof loaded.remoteBrowserCreateMediaAnswerInPage === "function" && typeof loaded.remoteBrowserCloseMediaPeerInPage === "function").toBe(true);
  return loaded as FrameMediaPeerModule;
}

const sourceFrameName = "frame-source-realm";
const sourceVideoHtml = "<video id=\"frame-source-video\" width=\"320\" height=\"180\" muted autoplay playsinline></video>";

// The frame holding the source video, its peer harness and the production slot; a Page means its top frame.
const sourceFrame = (target: Page | Frame): Frame => "mainFrame" in target ? target.mainFrame() : target;

// The top page always owns the live canvas stream. With "iframe" the video, the peers and the production functions
// live in a same-origin srcdoc child: a separate JS realm whose own MediaStream never matches the parent's stream.
async function prepareSourcePage(page: Page, realm: "top" | "iframe" = "top"): Promise<Frame> {
  await page.goto("about:blank");
  await page.setContent("<canvas id=\"frame-source-canvas\" width=\"320\" height=\"180\"></canvas>" + (realm === "iframe"
    ? `<iframe name="${sourceFrameName}" width="320" height="180" srcdoc='${sourceVideoHtml}'></iframe>` : sourceVideoHtml));
  await page.evaluate(() => {
    const canvas = document.getElementById("frame-source-canvas") as HTMLCanvasElement;
    const context = canvas.getContext("2d")!;
    let tick = 0;
    const draw = () => { context.fillStyle = `hsl(${(tick += 7) % 360} 70% 50%)`; context.fillRect(0, 0, canvas.width, canvas.height); };
    draw();
    (window as PeerWindow).__frameCredentialSource = { stream: canvas.captureStream(30), timer: window.setInterval(draw, 33) };
  });
  const frame = realm === "iframe" ? page.frame({ name: sourceFrameName }) : page.mainFrame();
  expect(frame !== null).toBe(true);
  const ready = await frame!.evaluate(async () => {
    const video = document.getElementById("frame-source-video") as HTMLVideoElement;
    const original = RTCPeerConnection.prototype.setRemoteDescription as (description?: RTCSessionDescriptionInit) => Promise<void>;
    const harness: PeerHarness = { pcs: [], gate: null, release: null, gateHit: false, video,
      restore: () => { RTCPeerConnection.prototype.setRemoteDescription = original as typeof RTCPeerConnection.prototype.setRemoteDescription; } };
    const patched = function (this: RTCPeerConnection, description?: RTCSessionDescriptionInit): Promise<void> {
      harness.pcs.push(this);
      const gate = harness.gate;
      if (!gate) return original.call(this, description);
      harness.gate = null;
      harness.gateHit = true;
      return gate.then(() => original.call(this, description));
    };
    RTCPeerConnection.prototype.setRemoteDescription = patched as typeof RTCPeerConnection.prototype.setRemoteDescription;
    (window as PeerWindow).__frameCredentialPeerTest = harness;
    // The top page's stream; the top frame is its own parent.
    video.srcObject = (window.parent as PeerWindow).__frameCredentialSource!.stream;
    await video.play().catch(() => undefined);
    const startedAt = Date.now();
    while ((video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) && Date.now() - startedAt < 5_000) {
      await new Promise(done => setTimeout(done, 50));
    }
    return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0
      && typeof (video as HTMLVideoElement & { captureStream?: unknown }).captureStream === "function";
  });
  expect(ready).toBe(true);
  return frame!;
}

async function receiverOffer(receiver: Page): Promise<RTCSessionDescriptionInit> {
  return receiver.evaluate(async () => {
    const scope = window as PeerWindow;
    const pc = new RTCPeerConnection({ iceServers: [] });
    (scope.__frameCredentialReceivers ??= []).push(pc);
    pc.addTransceiver("video", { direction: "recvonly" });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    return { type: offer.type, sdp: offer.sdp };
  });
}

async function peerState(target: Page | Frame, index: number): Promise<{ tracked: boolean; closed: boolean }> {
  return sourceFrame(target).evaluate(position => {
    const pc = (window as PeerWindow).__frameCredentialPeerTest?.pcs[position];
    return { tracked: Boolean(pc), closed: pc?.signalingState === "closed" };
  }, index);
}

// The top page's original stream, whichever realm plays it.
async function sourceTracksLive(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const tracks = (window as PeerWindow).__frameCredentialSource?.stream.getTracks() ?? [];
    return tracks.length > 0 && tracks.every(track => track.readyState === "live");
  });
}

// New presented frames distinguish a playing source from a live but frozen track.
async function sourceFramesAdvance(frame: Frame, windowMs = 1_000): Promise<boolean> {
  return frame.evaluate(async ms => {
    const video = document.getElementById("frame-source-video") as HTMLVideoElement;
    let presented = 0;
    let active = true;
    const tick = () => {
      if (!active) return;
      presented += 1;
      video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);
    await new Promise(done => setTimeout(done, ms));
    active = false;
    return presented >= 5;
  }, windowMs);
}

async function armNegotiationGate(target: Page | Frame): Promise<void> {
  await sourceFrame(target).evaluate(() => {
    const harness = (window as PeerWindow).__frameCredentialPeerTest!;
    harness.gateHit = false;
    harness.gate = new Promise<void>(done => { harness.release = done; });
  });
}

async function waitForGateHit(target: Page | Frame): Promise<void> {
  await expect.poll(() => sourceFrame(target).evaluate(() => (window as PeerWindow).__frameCredentialPeerTest?.gateHit ?? false), { timeout: 10_000 }).toBe(true);
}

async function releaseNegotiationGate(target: Page | Frame): Promise<void> {
  await sourceFrame(target).evaluate(() => (window as PeerWindow).__frameCredentialPeerTest?.release?.());
}

async function releasePeerPages(source: Page, receiver: Page): Promise<void> {
  // Child frames first; each frame releases only the gate, peers and video its own harness installed.
  for (const frame of [...source.frames()].reverse()) {
    await frame.evaluate(() => {
      const harness = (window as PeerWindow).__frameCredentialPeerTest;
      if (!harness) return;
      harness.release?.();
      harness.restore();
      for (const pc of harness.pcs) {
        for (const sender of pc.getSenders()) sender.track?.stop();
        pc.close();
      }
      harness.video.srcObject = null;
    }).catch(() => undefined);
  }
  await source.evaluate(() => {
    const owned = (window as PeerWindow).__frameCredentialSource;
    if (!owned) return;
    for (const track of owned.stream.getTracks()) track.stop();
    window.clearInterval(owned.timer);
  }).catch(() => undefined);
  await receiver.evaluate(() => { for (const pc of (window as PeerWindow).__frameCredentialReceivers ?? []) pc.close(); }).catch(() => undefined);
  await source.goto("about:blank").catch(() => undefined);
  await receiver.goto("about:blank").catch(() => undefined);
  await receiver.close().catch(() => undefined);
}

test("browser peer: the negotiated peer closes at its own deadline without a server release", async ({ page, context }) => {
  test.setTimeout(60_000);
  const peer = await loadFramePeer();
  const receiver = await context.newPage();
  try {
    await prepareSourcePage(page);
    const offer = await receiverOffer(receiver);
    const expiresAtMs = Date.now() + 6_000;
    const answered = summarizeAnswer(await page.evaluate(peer!.remoteBrowserCreateMediaAnswerInPage, { offer, iceServers: [], nonce: randomUUID(), expiresAtMs }));
    expect(answered).toEqual({ ok: true, hasAnswer: true });
    await sleep(expiresAtMs - Date.now() - 500);
    expect(await peerState(page, 0)).toEqual({ tracked: true, closed: false });
    // No remoteBrowserCloseMediaPeerInPage call: only the nonce-matched page timer may release this peer.
    await expect.poll(async () => (await peerState(page, 0)).closed, { timeout: expiresAtMs - Date.now() + 2_000 }).toBe(true);
  } finally {
    await releasePeerPages(page, receiver);
  }
});

test("browser peer: an older nonce release cannot close the newer peer", async ({ page, context }) => {
  test.setTimeout(60_000);
  const peer = await loadFramePeer();
  const receiver = await context.newPage();
  try {
    await prepareSourcePage(page);
    const older = randomUUID();
    const newer = randomUUID();
    const expiresAtMs = Date.now() + 30_000;
    expect(summarizeAnswer(await page.evaluate(peer!.remoteBrowserCreateMediaAnswerInPage,
      { offer: await receiverOffer(receiver), iceServers: [], nonce: older, expiresAtMs }))).toEqual({ ok: true, hasAnswer: true });
    expect(summarizeAnswer(await page.evaluate(peer!.remoteBrowserCreateMediaAnswerInPage,
      { offer: await receiverOffer(receiver), iceServers: [], nonce: newer, expiresAtMs }))).toEqual({ ok: true, hasAnswer: true });
    expect({ older: await peerState(page, 0), newer: await peerState(page, 1) })
      .toEqual({ older: { tracked: true, closed: true }, newer: { tracked: true, closed: false } });

    expect(await page.evaluate(peer!.remoteBrowserCloseMediaPeerInPage, older)).toBe(false);
    expect(await peerState(page, 1)).toEqual({ tracked: true, closed: false });
    expect(await page.evaluate(peer!.remoteBrowserCloseMediaPeerInPage, newer)).toBe(true);
    expect(await peerState(page, 1)).toEqual({ tracked: true, closed: true });
    // Same-realm MediaStream source: cleanup only detaches the capture, and the page's own tracks stay live.
    expect(await sourceTracksLive(page)).toBe(true);
  } finally {
    await releasePeerPages(page, receiver);
  }
});

test("browser peer: an offer whose deadline lapsed before it ran leaves the current peer, its deadline and its tracks untouched", async ({ page, context }) => {
  test.setTimeout(60_000);
  const peer = await loadFramePeer();
  const receiver = await context.newPage();
  try {
    await prepareSourcePage(page);
    const current = randomUUID();
    expect(summarizeAnswer(await page.evaluate(peer!.remoteBrowserCreateMediaAnswerInPage,
      { offer: await receiverOffer(receiver), iceServers: [], nonce: current, expiresAtMs: Date.now() + 30_000 }))).toEqual({ ok: true, hasAnswer: true });
    const timerId = await page.evaluate(() => (window as PeerWindow).__VRATA_REMOTE_BROWSER_MEDIA__?.expiryTimer ?? null);
    expect(typeof timerId).toBe("number");

    // As if queued behind frame.evaluate until after its socket lease ended.
    const lapsed = await page.evaluate(peer!.remoteBrowserCreateMediaAnswerInPage,
      { offer: await receiverOffer(receiver), iceServers: [], nonce: randomUUID(), expiresAtMs: Date.now() - 1_000 }).then(summarizeAnswer, () => null);
    expect(lapsed).toEqual(noAnswer);
    expect(await page.evaluate(({ nonce, timer }) => {
      const scope = window as PeerWindow;
      const harness = scope.__frameCredentialPeerTest!;
      const slot = scope.__VRATA_REMOTE_BROWSER_MEDIA__;
      const pc = harness.pcs[0];
      const senders = pc?.getSenders() ?? [];
      return {
        negotiatedOnlyCurrent: harness.pcs.length === 1,
        slotKeepsCurrent: Boolean(pc) && slot?.pc === pc && slot?.peerNonce === nonce,
        deadlineKept: slot?.expiryTimer === timer,
        currentOpen: Boolean(pc) && pc.signalingState !== "closed",
        currentTracksLive: senders.length > 0 && senders.every(sender => sender.track?.readyState === "live")
      };
    }, { nonce: current, timer: timerId })).toEqual({
      negotiatedOnlyCurrent: true, slotKeepsCurrent: true, deadlineKept: true, currentOpen: true, currentTracksLive: true
    });
    expect(await sourceTracksLive(page)).toBe(true);
  } finally {
    await releasePeerPages(page, receiver);
  }
});

test("browser peer: a displaced overlapping negotiation closes its own peer and the current peer lasts until its deadline", async ({ page, context }) => {
  test.setTimeout(60_000);
  const peer = await loadFramePeer();
  const receiver = await context.newPage();
  try {
    await prepareSourcePage(page);
    const offerA = await receiverOffer(receiver);
    const offerB = await receiverOffer(receiver);
    await armNegotiationGate(page);
    const pendingA = page.evaluate(peer!.remoteBrowserCreateMediaAnswerInPage, { offer: offerA, iceServers: [], nonce: randomUUID(), expiresAtMs: Date.now() + 30_000 })
      .then(summarizeAnswer, () => noAnswer);
    await waitForGateHit(page);

    const deadlineB = Date.now() + 8_000;
    expect(summarizeAnswer(await page.evaluate(peer!.remoteBrowserCreateMediaAnswerInPage, { offer: offerB, iceServers: [], nonce: randomUUID(), expiresAtMs: deadlineB })))
      .toEqual({ ok: true, hasAnswer: true });
    await releaseNegotiationGate(page);
    expect(await pendingA).toEqual(noAnswer);
    expect({ displaced: await peerState(page, 0), current: await peerState(page, 1) })
      .toEqual({ displaced: { tracked: true, closed: true }, current: { tracked: true, closed: false } });

    await sleep(deadlineB - Date.now() - 500);
    expect(await peerState(page, 1)).toEqual({ tracked: true, closed: false });
    await expect.poll(async () => (await peerState(page, 1)).closed, { timeout: deadlineB - Date.now() + 2_000 }).toBe(true);
  } finally {
    await releasePeerPages(page, receiver);
  }
});

test("browser peer: a negotiation finishing after its deadline installs no peer and emits no answer", async ({ page, context }) => {
  test.setTimeout(60_000);
  const peer = await loadFramePeer();
  const receiver = await context.newPage();
  try {
    await prepareSourcePage(page);
    const offer = await receiverOffer(receiver);
    await armNegotiationGate(page);
    const expiresAtMs = Date.now() + 1_500;
    const pending = page.evaluate(peer!.remoteBrowserCreateMediaAnswerInPage, { offer, iceServers: [], nonce: randomUUID(), expiresAtMs })
      .then(summarizeAnswer, () => noAnswer);
    await waitForGateHit(page);
    await sleep(expiresAtMs - Date.now() + 300);
    await releaseNegotiationGate(page);
    expect(await pending).toEqual(noAnswer);
    expect(await peerState(page, 0)).toEqual({ tracked: true, closed: true });
  } finally {
    await releasePeerPages(page, receiver);
  }
});

test("browser peer: a same-origin iframe playing the parent's stream keeps the parent's tracks live through matched close, displacement and expiry", async ({ page, context }) => {
  test.setTimeout(60_000);
  const peer = await loadFramePeer();
  const receiver = await context.newPage();
  try {
    const frame = await prepareSourcePage(page, "iframe");
    // Precondition: before capture, the child's own MediaStream rejects the parent's stream. Current Chromium passes
    // production's instanceof check after captureStream(), so cleanup detaches rather than stops. The contract below
    // does not depend on that branch: each peer closes and the parent's source stays live and keeps presenting frames.
    expect(await frame.evaluate(() => {
      const video = document.getElementById("frame-source-video") as HTMLVideoElement;
      const parent = window.parent as PeerWindow & typeof globalThis;
      return {
        childRealm: parent !== window && parent.MediaStream !== MediaStream,
        parentStream: video.srcObject === parent.__frameCredentialSource?.stream,
        instanceofMediaStream: video.srcObject instanceof MediaStream
      };
    })).toEqual({ childRealm: true, parentStream: true, instanceofMediaStream: false });
    await page.bringToFront();
    expect(await sourceFramesAdvance(frame)).toBe(true);
    const negotiate = async (nonce: string, expiresAtMs: number) => summarizeAnswer(await frame.evaluate(peer.remoteBrowserCreateMediaAnswerInPage,
      { offer: await receiverOffer(receiver), iceServers: [], nonce, expiresAtMs }));

    const released = randomUUID();
    expect(await negotiate(released, Date.now() + 30_000)).toEqual({ ok: true, hasAnswer: true });
    expect(await frame.evaluate(peer.remoteBrowserCloseMediaPeerInPage, released)).toBe(true);
    expect({ peer: await peerState(frame, 0), sourceLive: await sourceTracksLive(page), framesAdvance: await sourceFramesAdvance(frame) })
      .toEqual({ peer: { tracked: true, closed: true }, sourceLive: true, framesAdvance: true });

    expect(await negotiate(randomUUID(), Date.now() + 30_000)).toEqual({ ok: true, hasAnswer: true });
    const deadline = Date.now() + 8_000;
    expect(await negotiate(randomUUID(), deadline)).toEqual({ ok: true, hasAnswer: true });
    expect({ displaced: await peerState(frame, 1), current: await peerState(frame, 2), sourceLive: await sourceTracksLive(page),
      framesAdvance: await sourceFramesAdvance(frame) })
      .toEqual({ displaced: { tracked: true, closed: true }, current: { tracked: true, closed: false }, sourceLive: true,
        framesAdvance: true });

    // No server release: only the nonce-matched in-page timer closes the current peer.
    await expect.poll(async () => (await peerState(frame, 2)).closed, { timeout: deadline - Date.now() + 2_000 }).toBe(true);
    expect(await sourceTracksLive(page)).toBe(true);
    expect(await sourceFramesAdvance(frame)).toBe(true);
    // Negative control: ending the original source must be observable by this same frame-progress probe.
    await page.evaluate(() => (window as PeerWindow).__frameCredentialSource?.stream.getTracks().forEach(track => track.stop()));
    expect(await sourceFramesAdvance(frame)).toBe(false);
  } finally {
    await releasePeerPages(page, receiver);
  }
});
