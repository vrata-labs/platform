import { expect } from "@playwright/test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { bearer, inviteTokenFromLink, privateHttp } from "./plugin-author-scenarios";
import { admitInvitation } from "./staging-identity";
import type { RoomPluginOrigin } from "./room-plugin-fixture";

/** Two genuine contenders (not observers), with no additional 3D renderers. */
export async function runSeatProtocolRace(value: RoomPluginOrigin, roomId: string, liveIds: string[], seatId: string) {
  const { WebSocket } = createRequire(resolve("apps/room-state/package.json"))("ws");
  const actors: Array<{ socket: any; participantId: string; result?: { commandId: string; accepted: boolean; occupantId: string };
    snapshot?: { ids: string[]; occupancy: Record<string, string> }; released: boolean }> = [];
  const inviteIds: string[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      const invitation = await privateHttp(value.origin, `/api/rooms/${roomId}/invites`, "POST", { "x-vrata-admin-token": value.adminToken }, { role: "member", expiresInSeconds: 600 });
      expect(invitation.status).toBe(201);
      const invite = invitation.json<{ inviteId: string; inviteLink: string }>(); inviteIds.push(invite.inviteId);
      const session = await admitInvitation(value.origin, roomId, inviteTokenFromLink(invite.inviteLink), `Seat protocol contender ${index + 1}`);
      expect(session.identityProtocolVersion).toBe(2);
      const manifest = await privateHttp(value.origin, `/api/rooms/${roomId}/manifest`, "GET", bearer(session.token));
      expect(manifest.status).toBe(200);
      const url = new URL(manifest.json<{ realtime: { roomStateUrl: string } }>().realtime.roomStateUrl);
      url.searchParams.set("roomId", roomId); url.searchParams.set("participantId", session.participantId); url.searchParams.set("accessToken", session.token);
      const socket = new WebSocket(url.href);
      const actor: typeof actors[number] = { socket, participantId: session.participantId, released: false };
      actors.push(actor);
      socket.on("error", () => { /* A fixed timeout/failure below cannot leak a credential-bearing URL. */ });
      socket.on("message", (bytes: Buffer) => {
        if (bytes.byteLength > 262_144) return;
        let message: any; try { message = JSON.parse(bytes.toString()); } catch { return; }
        if (message.type === "room_state" && message.room?.participants?.length <= 64) actor.snapshot = {
          ids: message.room.participants.map((p: any) => p.participantId), occupancy: { ...message.room.seatOccupancy } };
        if (message.type === "seat_claim_result" && message.seatClaimResult?.commandId === `t16-race-${index}`) {
          const result = message.seatClaimResult;
          actor.result = { commandId: result.commandId, accepted: result.accepted, occupantId: result.occupantId };
        }
        if (message.type === "seat_release_result" && message.seatReleaseResult?.commandId === "t16-race-release") actor.released = true;
      });
    }
    const expected = [...liveIds, ...actors.map(actor => actor.participantId)].sort();
    await expect.poll(() => actors.every(actor => actor.socket.readyState === WebSocket.OPEN
      && JSON.stringify(actor.snapshot?.ids.slice().sort()) === JSON.stringify(expected)), { timeout: 15_000 }).toBe(true);
    // Both sends happen in one turn, against exactly the same unoccupied seat.
    for (const [index, actor] of actors.entries()) actor.socket.send(JSON.stringify({ type: "seat_claim", seatId, commandId: `t16-race-${index}` }));
    await expect.poll(() => actors.every(actor => actor.result !== undefined), { timeout: 15_000 }).toBe(true);
    expect(actors.filter(actor => actor.result!.accepted).length).toBe(1);
    const winner = actors.find(actor => actor.result!.accepted)!;
    const loser = actors.find(actor => !actor.result!.accepted)!;
    expect(loser.result!.occupantId === winner.participantId).toBe(true);
    await expect.poll(() => actors.every(actor => actor.snapshot?.occupancy[seatId] === winner.participantId), { timeout: 15_000 }).toBe(true);
    winner.socket.send(JSON.stringify({ type: "seat_release", seatId, commandId: "t16-race-release" }));
    await expect.poll(() => winner.released && actors.every(actor => !actor.snapshot?.occupancy[seatId]), { timeout: 15_000 }).toBe(true);
  } finally {
    for (const actor of actors) { actor.socket.removeAllListeners("message"); actor.socket.close(); actor.snapshot = undefined; actor.result = undefined; }
    for (const inviteId of inviteIds) expect((await privateHttp(value.origin, `/api/rooms/${roomId}/invites/${inviteId}/revoke`, "POST",
      { "x-vrata-admin-token": value.adminToken })).status).toBe(200);
  }
}
