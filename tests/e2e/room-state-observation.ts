import { expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { cleanupAll } from "./test-cleanup";

type SocketScope = { socketScope: string; generation: number; sequence: number };
type Snapshot = SocketScope & { participants: string[]; occupancy: Record<string, string>; mediaHash: string };
type Command = SocketScope & { observedAtMs: number; commandId: string; type: string; seatId: string | null; accepted: boolean | null; occupantId: string | null; permissionDenied: boolean };
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value);

/** Passive CDP observation of the client's EXISTING authenticated transport.
 * No extra identity/socket, raw frame, URL, token, source or config is retained.
 * Only bounded allowlisted DTOs live in memory; callers assert booleans, not DTOs. */
export async function captureRoomAuthority(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const sockets = new Map<string, SocketScope>();
  const commands: Command[] = [];
  const barriers = new Set<{ participantId: string; marker: number; observed: Snapshot | null }>();
  let latest: Snapshot | null = null, received = 0, connections = 0;
  const created = (event: { requestId: string; url: string }) => {
    try {
      const query = new URL(event.url).searchParams;
      if (query.has("roomId") && query.has("participantId") && query.has("accessToken") && sockets.size < 32) {
        connections++;
        sockets.set(event.requestId, { socketScope: `socket-${connections}`, generation: connections, sequence: 0 });
        latest = null; // A previous connection cannot prove admission of this one.
      }
    } catch { /* Never retain URL/error data. */ }
  };
  const closed = (event: { requestId: string }) => {
    const scope = sockets.get(event.requestId);
    if (scope?.generation === latest?.generation) latest = null;
    for (const barrier of barriers) if (barrier.observed?.generation === scope?.generation) barrier.observed = null;
    sockets.delete(event.requestId);
  };
  const frame = (direction: "sent" | "received", event: { requestId: string; response: { opcode: number; payloadData: string } }) => {
    if (!sockets.has(event.requestId) || event.response.opcode !== 1 || event.response.payloadData.length > 262_144) return;
    const scope = sockets.get(event.requestId)!;
    scope.sequence++;
    let payload: any;
    try { payload = JSON.parse(event.response.payloadData); } catch { return; }
    if (direction === "received" && payload?.type === "room_state") {
      if (scope.generation !== connections) return; // An overlapping old transport is not current authority.
      const room = payload.room;
      if (!Array.isArray(room?.participants) || room.participants.length > 64 || !room.participants.every((p: any) => id(p?.participantId))) return;
      const entries = Object.entries(room.seatOccupancy ?? {});
      if (entries.length > 64 || !entries.every(([seat, pid]) => id(seat) && id(pid))) return;
      latest = { ...scope, participants: room.participants.map((p: any) => p.participantId), occupancy: Object.fromEntries(entries) as Record<string, string>,
        mediaHash: createHash("sha256").update(JSON.stringify(room.mediaObjects ?? null)).digest("hex") };
      for (const barrier of barriers) {
        if (room.participants.some((p: any) => p.participantId === barrier.participantId && p.clientTimeMs === barrier.marker)) barrier.observed = latest;
      }
      received++;
      return;
    }
    const value = direction === "sent" ? payload : payload?.seatClaimResult ?? payload?.seatReleaseResult ?? payload?.result;
    if (!id(value?.commandId) || !/^(?:plugin-seat:|plugin-release:|t16-)/.test(value.commandId)) return;
    if (!["seat_claim", "seat_release", "seat_claim_result", "seat_release_result", "surface_create_object", "access_denied", "surface_command_result"].includes(payload.type)) return;
    commands.push({ ...scope, observedAtMs: performance.now(), commandId: value.commandId, type: payload.type, seatId: id(value.seatId) ? value.seatId : null,
      accepted: typeof value.accepted === "boolean" ? value.accepted : null, occupantId: id(value.occupantId) ? value.occupantId : null,
      permissionDenied: value.blockedReason === "missing-permission" });
    if (commands.length > 128) commands.shift();
  };
  const sent = (event: any) => frame("sent", event), incoming = (event: any) => frame("received", event);
  cdp.on("Network.webSocketCreated", created);
  cdp.on("Network.webSocketClosed", closed);
  cdp.on("Network.webSocketFrameSent", sent);
  cdp.on("Network.webSocketFrameReceived", incoming);
  await cdp.send("Network.enable");
  return {
    snapshot: () => latest,
    received: () => received,
    connections: () => connections,
    generation: () => connections,
    commands: () => commands,
    watchParticipantBarrier(participantId: string, marker: number) {
      if (!id(participantId) || !Number.isSafeInteger(marker) || barriers.size >= 8) throw new Error("t16_invalid_authority_barrier");
      const barrier = { participantId, marker, observed: null as Snapshot | null };
      barriers.add(barrier);
      return { snapshot: () => barrier.observed?.generation === connections ? barrier.observed : null,
        close: () => { barriers.delete(barrier); barrier.observed = null; } };
    },
    async close() {
      cdp.off("Network.webSocketCreated", created); cdp.off("Network.webSocketClosed", closed);
      cdp.off("Network.webSocketFrameSent", sent); cdp.off("Network.webSocketFrameReceived", incoming);
      sockets.clear(); commands.length = 0; latest = null;
      for (const barrier of barriers) barrier.observed = null;
      barriers.clear();
      if (!page.isClosed()) await cdp.detach(); // A closed page has already detached its session.
    }
  };
}
export type RoomAuthorityCapture = Awaited<ReturnType<typeof captureRoomAuthority>>;
export type AuthorityClient = { page: Page; participantId: string; authority: RoomAuthorityCapture };

export async function expectExactRoomAuthority(clients: AuthorityClient[], timeout = 45_000) {
  const ids = clients.map(client => client.participantId).sort();
  expect(new Set(ids).size === ids.length).toBe(true);
  await expect.poll(async () => {
    const snapshots = clients.map(client => client.authority.snapshot());
    const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const sorted = (occupancy: Record<string, string>) => Object.entries(occupancy).sort(([a], [b]) => a.localeCompare(b));
    if (snapshots.some(value => !value || !equal([...value.participants].sort(), ids)
      || new Set(value.participants).size !== ids.length || Object.values(value.occupancy).some(pid => !ids.includes(pid))
      || new Set(Object.values(value.occupancy)).size !== Object.values(value.occupancy).length)) return false;
    const canonical = snapshots[0]!;
    if (snapshots.some(value => !equal(sorted(value!.occupancy), sorted(canonical.occupancy)))) return false;
    return (await Promise.all(clients.map(client => client.page.evaluate(({ ids, occupancy, own }) => {
      const debug = (window as any).__VRATA_DEBUG__;
      const remote = (debug?.remoteParticipants ?? []).map((p: any) => p.participantId).sort();
      const expected = ids.filter(pid => pid !== own);
      const entries = (value: Record<string, string>) => Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
      const seat = Object.entries(occupancy).find(([, pid]) => pid === own)?.[0] ?? null;
      return debug?.roomStateConnected === true && debug?.participantId === own
        && JSON.stringify(remote) === JSON.stringify(expected)
        && JSON.stringify(entries(debug?.seatOccupancy ?? {})) === JSON.stringify(entries(occupancy))
        && (debug?.currentSeatId ?? null) === seat;
    }, { ids, occupancy: canonical.occupancy, own: client.participantId })))).every(Boolean);
  }, { timeout, intervals: [250, 500, 1000] }).toBe(true);
}

/** Adversarial commands on the already-open socket, without exposing its URL or
 * creating an observer. Separate from the passive authority capture above. */
export async function installExistingSocketControl(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  // A fresh CDP session does not inherit Playwright's Page domain enablement.
  // Without it Chromium accepts registration but never executes this init script.
  await cdp.send("Page.enable");
  const result = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${(() => {
    const Native = window.WebSocket;
    let socket: WebSocket | undefined;
    let heldSocket: WebSocket | undefined;
    let heldClose: WebSocket["close"] | undefined;
    let closeRequested = false;
    const release = () => {
      const target = heldSocket, close = heldClose;
      heldSocket = undefined; heldClose = undefined;
      if (target && close) {
        delete (target as { close?: WebSocket["close"] }).close;
        // Complete the client's deferred retirement, not a new connection.
        if (closeRequested) close.call(target);
      }
      closeRequested = false;
    };
    const Wrapped = new Proxy(Native, { construct(target, args, newTarget) {
      const value = Reflect.construct(target, args, newTarget) as WebSocket;
      if (new URL(value.url).searchParams.has("roomId")) socket = value;
      return value;
    } });
    window.WebSocket = Wrapped;
    (window as any).__t16HoldSocket = () => {
      if (heldSocket) throw new Error("t16_transport_already_held");
      if (!socket || socket.readyState !== Native.OPEN) throw new Error("t16_transport_not_open");
      heldSocket = socket;
      heldClose = socket.close;
      // Role updates voluntarily reconnect the normal client. Retain only its
      // already-authenticated OLD transport for this adversarial command; server
      // closes and all server authorization still apply normally. New transports
      // are created by the runtime, never by this hook.
      socket.close = () => { closeRequested = true; };
    };
    (window as any).__t16ReleaseSocket = release;
    (window as any).__t16SocketCommand = (command: unknown) => {
      const target = heldSocket ?? socket;
      if (!target) throw new Error("t16_transport_missing");
      if (target.readyState !== Native.OPEN) return "closed";
      target.send(JSON.stringify(command));
      return "sent";
    };
    (window as any).__t16SocketCleanup = () => {
      release(); socket = undefined;
      if (window.WebSocket === Wrapped) window.WebSocket = Native;
      delete (window as any).__t16HoldSocket; delete (window as any).__t16ReleaseSocket;
      delete (window as any).__t16SocketCommand; delete (window as any).__t16SocketCleanup;
    };
  }).toString()})()` });
  return async () => {
    await cleanupAll([
      () => !page.isClosed() ? page.evaluate(() => (window as any).__t16SocketCleanup?.()) : undefined,
      () => !page.isClosed() ? cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: result.identifier }) : undefined,
      () => !page.isClosed() ? cdp.detach() : undefined
    ]);
  };
}
