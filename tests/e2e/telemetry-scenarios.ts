import { randomUUID } from "node:crypto";
import { expect } from "playwright/test";
import { bearer, inviteTokenFromLink, privateHttp } from "./plugin-author-scenarios";

// Native fetch and scalar assertions avoid private credentials in API call logs.
export async function runPersistedTelemetryRoundTrip(origin: string, admin: Record<string, string>): Promise<void> {
  const tenantId = `telemetry-${randomUUID()}`;
  let tenantCreated = false, roomId: string | undefined, inviteId: string | undefined;
  try {
    expect((await privateHttp(origin, "/api/tenants", "POST", admin, { tenantId, name: "Telemetry acceptance" })).status).toBe(201);
    tenantCreated = true;
    const created = await privateHttp(origin, "/api/rooms", "POST", admin, { tenantId, templateId: "meeting-room-basic",
      name: "Owned telemetry round trip", visibility: "private", guestAllowed: false });
    expect(created.status).toBe(201); roomId = created.json<{ roomId: string }>().roomId;
    const invitation = await privateHttp(origin, `/api/rooms/${roomId}/invites`, "POST", admin,
      { role: "host", waitingRoomEnabled: false, expiresInSeconds: 600 });
    expect(invitation.status).toBe(201);
    const invite = invitation.json<{ inviteId: string; inviteLink: string }>(); inviteId = invite.inviteId;
    const participantId = `telemetry-host-${randomUUID()}`;
    const admitted = await privateHttp(origin, "/api/tokens/state", "POST", {}, { roomId, participantId,
      displayName: "Telemetry Host", inviteToken: inviteTokenFromLink(invite.inviteLink) });
    expect(admitted.status).toBe(200);
    const host = admitted.json<{ token: string; role: string }>(); expect(host.role === "host").toBe(true);
    const headers = bearer(host.token), stem = `/api/rooms/${roomId}`;
    const control = await privateHttp(origin, `${stem}/session-control`, "GET", headers);
    expect(control.status).toBe(200);
    expect(control.json<{ state: { hostParticipantId: string } }>().state.hostParticipantId === participantId).toBe(true);
    const report = await privateHttp(origin, `${stem}/diagnostics`, "POST", headers, { participantId,
      note: "telemetry_round_trip", sessionToken: "fixture-redacted-proof",
      sceneDebug: { screenshot: { dataUrl: "data:image/png;base64,ZXhhbXBsZQ==", width: 1, height: 1 } } });
    expect(report.status).toBe(201);
    expect(typeof report.json<{ reportId: string }>().reportId === "string").toBe(true);
    const diagnostics = await privateHttp(origin, `${stem}/diagnostics`, "GET", admin);
    expect(diagnostics.status).toBe(200);
    const reports = diagnostics.json<{ items: Array<{ participantId: string; sessionToken?: string;
      sceneDebug?: { screenshot?: { dataUrl?: string } } }> }>().items;
    expect(reports.length).toBe(1);
    expect(reports[0].participantId === participantId).toBe(true);
    expect(reports[0].sessionToken === "fixture-redacted-proof").toBe(false);
    expect(reports[0].sceneDebug?.screenshot?.dataUrl === undefined).toBe(true);

    const now = Date.now(), xrPath = `${stem}/xr-telemetry/${participantId}`;
    const record = { roomId: "payload-room", participantId: "payload-participant", currentSeatId: null,
      kind: "seat", statusLine: "telemetry-committed", updatedAt: new Date(now).toISOString(),
      interactionRay: { active: false, origin: { x: 1, z: 2 } } };
    expect((await privateHttp(origin, xrPath, "PUT", headers, record)).status).toBe(200);
    const { kind: _kind, ...idle } = record;
    expect((await privateHttp(origin, xrPath, "PUT", headers,
      { ...idle, statusLine: "telemetry-idle-latest", updatedAt: new Date(now + 1000).toISOString() })).status).toBe(200);
    const read = await privateHttp(origin, `${stem}/xr-telemetry`, "GET", headers);
    expect(read.status).toBe(200);
    const items = read.json<{ items: Array<{ roomId: string; participantId: string; statusLine: string; history: Array<{ kind: string }> }> }>().items;
    expect(items.length).toBe(1);
    expect(items[0].roomId === roomId && items[0].participantId === participantId).toBe(true);
    expect(items[0].statusLine === "telemetry-idle-latest").toBe(true);
    expect(items[0].history.length).toBe(1);
    expect(items[0].history[0].kind === "seat").toBe(true);
    expect((await privateHttp(origin, `${stem}/xr-telemetry`)).status).toBe(401);
  } finally {
    let failed = false;
    if (roomId && inviteId) try { expect((await privateHttp(origin, `/api/rooms/${roomId}/invites/${inviteId}/revoke`, "POST", admin)).status).toBe(200); } catch { failed = true; }
    if (roomId) try { expect((await privateHttp(origin, `/api/rooms/${roomId}`, "DELETE", admin)).status).toBe(200); } catch { failed = true; }
    if (tenantCreated) try { expect((await privateHttp(origin, `/api/tenants/${tenantId}`, "DELETE", admin)).status).toBe(200); } catch { failed = true; }
    if (failed) throw new Error("telemetry_owned_resources_cleanup_failed");
  }
}
