import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as httpServer, request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { PostgresStorage } from "./storage.js";
import { getRoomPermissions } from "@vrata/shared-types";
import { signRoomSessionToken } from "@vrata/shared-types/session-token";

test("legacy DELETE intent precedes cleanup and personal bootstrap/reopen cannot outlive cutover", {
  skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 90_000
}, async t => {
  assert.ok(process.env.VRATA_TEST_POSTGRES_URL);
  const schema = `delete_bootstrap_${randomUUID().replaceAll("-", "")}`;
  const root = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL });
  await root.query(`create schema "${schema}"`);
  const connection = new URL(process.env.VRATA_TEST_POSTGRES_URL);
  connection.searchParams.set("options", `-c search_path=${schema},public`);
  const pool = new Pool({ connectionString: connection.href });
  t.after(async () => { await pool.end(); await root.query(`drop schema "${schema}" cascade`); await root.end(); });
  const storage = new PostgresStorage(pool);
  await storage.init();
  const room = await storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Legacy deletion",
    sessionControl: { hostParticipantId: "legacy-host" } });
  const blockedRoom = await storage.createRoom({ tenantId: room.tenantId, templateId: "meeting-room-basic", name: "Blocked deletion",
    sessionControl: { hostParticipantId: "legacy-host" } });
  const secret = "delete-bootstrap-http-test-key-32-bytes";
  const hostToken = (roomId: string) => signRoomSessionToken({ tenantId: room.tenantId, roomId, participantId: "legacy-host", displayName: "Host",
    role: "host", roleSource: "trusted", permissions: getRoomPermissions("host"), sessionId: randomUUID(), jti: randomUUID(),
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 }, secret);
  const uploadRoot = await mkdtemp(join(tmpdir(), "vrata-delete-bootstrap-"));
  let cleanupFails = true;
  let cleanupRaises = false;
  let cleanupCalls = 0;
  let probeFence = true;
  const cleanupIssues: string[] = [];
  const state = httpServer((request, response) => {
    void (async () => {
      cleanupCalls++;
      const documentId = /\/documents\/([^/]+)/.exec(request.url ?? "")?.[1];
      if (!documentId || !(await storage.getRoomDocument(room.roomId, documentId))?.deletedAt) cleanupIssues.push("cleanup_before_tombstone");
      // Global NOWAIT probes are meaningful only without competing DELETEs.
      // Another request's correct fence must not be mistaken for this one's.
      if (probeFence) {
        const probe = await pool.connect();
        try {
          await probe.query("begin");
          await probe.query("select room_id from rooms where room_id=$1 for update nowait", [room.roomId]);
          await probe.query("lock table room_identity_protocol_policy in exclusive mode nowait");
        } catch { cleanupIssues.push("cleanup_under_fence"); }
        finally { await probe.query("rollback").catch(() => undefined); probe.release(); }
      }
      if (cleanupRaises) { cleanupRaises = false; await storage.identityProtocol.raise(2); }
      response.writeHead(cleanupFails ? 503 : 200, { "content-type": "application/json" });
      response.end(JSON.stringify({ removedCount: 0 }));
    })().catch(() => { response.writeHead(500); response.end(); });
  });
  state.listen(0, "127.0.0.1");
  await once(state, "listening");
  const statePort = (state.address() as { port: number }).port;
  const reserve = createServer(); reserve.listen(0, "127.0.0.1"); await once(reserve, "listening");
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  // Observe a body parser wait and pause manifest preparation only in the
  // test process. There are no special server endpoints or production hooks.
  const script = `
    const {IncomingMessage}=await import('node:http');
    const {PostgresStorage}=await import(${JSON.stringify(new URL("./storage.js", import.meta.url).href)});
    const {RoomFenceCommitUncertain}=await import(${JSON.stringify(new URL("./identity/fence-transaction.js", import.meta.url).href)});
    const on=IncomingMessage.prototype.on,list=PostgresStorage.prototype.listAssets;
    const get=PostgresStorage.prototype.getRoomDocument;
    let gateDoc,gated=0,releases=[];
    const rooms=PostgresStorage.prototype.listRooms,owned=PostgresStorage.prototype.createPersonalOwnedRoom;
    const templates=PostgresStorage.prototype.listTemplates;
    let failRooms=false,failOwned=false,failTemplates=false;
    PostgresStorage.prototype.listTemplates=async function(){
      if(failTemplates){failTemplates=false;throw Object.assign(new Error('test-template-reset'),{code:'ECONNRESET'});}
      return templates.call(this);
    };
    let gateOwner,roomReads=0,roomReleases=[];
    PostgresStorage.prototype.listRooms=async function(){
      if(failRooms){failRooms=false;throw Object.assign(new Error('test-list-rooms-reset'),{code:'ECONNRESET'});}
      const rows=await rooms.call(this);
      if(gateOwner && roomReads<2 && !rows.some(row=>row.ownerParticipantId===gateOwner)){
        ++roomReads;
        await new Promise(r=>{roomReleases.push(r);process.send(roomReads===1?'first-personal-paused':'both-personal-paused');});
      }
      return rows;
    };
    PostgresStorage.prototype.createPersonalOwnedRoom=async function(input){
      if(failOwned){failOwned=false;throw new RoomFenceCommitUncertain(new Error('test-bootstrap-commit-unconfirmed'));}
      return owned.call(this,input);
    };
    let bodyArmed=false,reopenArmed=false,resume;
    IncomingMessage.prototype.on=function(event,...args){
      const result=on.call(this,event,...args);
      if(bodyArmed && event==='end' && this.method==='POST' && this.url==='/api/personal-room'){
        bodyArmed=false;setImmediate(()=>process.send('body-wait'));
      }
      return result;
    };
    PostgresStorage.prototype.listAssets=async function(){
      if(reopenArmed){reopenArmed=false;process.send('reopen-prepared');await new Promise(r=>{resume=r;});}
      return list.call(this);
    };
    PostgresStorage.prototype.getRoomDocument=async function(roomId,documentId){
      const row=await get.call(this,roomId,documentId);
      if(gateDoc===documentId && !this.effectClient && row && !row.deletedAt && gated<2){
        if(++gated===2) process.send('delete-reads-paused');
        await new Promise(r=>releases.push(r));
      }
      return row;
    };
    process.on('message',message=>{
      if(message==='arm-template-failure'){failTemplates=true;process.send('template-failure-armed');}
      if(message?.arm==='personal-reads'){gateOwner=message.owner;roomReads=0;process.send('personal-reads-armed');}
      if(message==='resume-first-personal'){roomReleases.shift()?.();}
      if(message==='resume-personal-reads'){gateOwner=undefined;roomReleases.splice(0).forEach(r=>r());}
      if(message==='arm-room-failure'){failRooms=true;process.send('room-failure-armed');}
      if(message==='arm-owned-failure'){failOwned=true;process.send('owned-failure-armed');}
      if(message?.arm==='delete-reads'){gateDoc=message.documentId;gated=0;process.send('delete-reads-armed');}
      if(message==='resume-delete-reads'){gateDoc=undefined;releases.splice(0).forEach(r=>r());}
      if(message==='arm-body'){bodyArmed=true;process.send('body-armed');}
      if(message==='arm-reopen'){reopenArmed=true;process.send('reopen-armed');}
      if(message==='resume'){resume?.();}
    });
    await import(${JSON.stringify(new URL("./index.js", import.meta.url).href)});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, NODE_ENV: "development", API_PORT: String(port), POSTGRES_URL: connection.href,
      STATE_TOKEN_SECRET: secret, CONTROL_PLANE_ADMIN_TOKEN: "test-admin", ROOM_ACCESS_POLICY_ENABLED: "true", FEATURE_HOST_CONTROLS: "true",
      DOCUMENT_LOCAL_UPLOAD_ROOT: uploadRoot, ROOM_STATE_INTERNAL_URL: `http://127.0.0.1:${statePort}`, VRATA_INTERNAL_SERVICE_TOKEN: "delete-bootstrap-internal-test-key-32-bytes" } });
  let log = ""; child.stdout!.on("data", chunk => { log += String(chunk); }); child.stderr!.on("data", chunk => { log += String(chunk); });
  const base = `http://127.0.0.1:${port}`;
  const admin = { "x-vrata-admin-token": "test-admin" };
  const headers = { authorization: `Bearer ${hostToken(room.roomId)}` };
  const owner = `owner-${randomUUID()}`;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { ready = await fetch(`${base}/health`).then(r => r.ok).catch(() => false); if (ready) break; await delay(60); }
    assert.equal(ready, true, log);
    const failures = async () => {
      const match = /^vrata_api_request_failures_total (\d+)$/m.exec(await (await fetch(`${base}/metrics`)).text());
      assert.ok(match); return Number(match[1]);
    };
    const beforeTemplateFailure = await failures();
    const armedTemplates = once(child, "message"); child.send("arm-template-failure");
    assert.equal((await armedTemplates)[0], "template-failure-armed");
    const templateFailure = await fetch(`${base}/api/personal-room`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ participantId: `template-error-${randomUUID()}` }) });
    assert.equal(templateFailure.status, 500);
    assert.equal((await templateFailure.json() as { error: string }).error, "internal_error");
    assert.equal(await failures(), beforeTemplateFailure + 1, "unfenced template failures retain ordinary request accounting");
    const personal = () => fetch(`${base}/api/personal-room`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ participantId: owner, displayName: "Owner" }) });
    const created = await personal(); assert.equal(created.status, 201);
    const existing = await created.json() as { room: { roomId: string } };
    assert.equal((await personal()).status, 200);
    const simultaneousOwner = `concurrent-${randomUUID()}`;
    const armPersonal = once(child, "message"); child.send({ arm: "personal-reads", owner: simultaneousOwner });
    assert.equal((await armPersonal)[0], "personal-reads-armed");
    const concurrentPersonal = () => fetch(`${base}/api/personal-room`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ participantId: simultaneousOwner, displayName: "Concurrent" })
    });
    const firstPaused = once(child, "message", { signal: AbortSignal.timeout(5000) });
    const firstPersonal = concurrentPersonal(); assert.equal((await firstPaused)[0], "first-personal-paused");
    const bothPaused = once(child, "message", { signal: AbortSignal.timeout(5000) });
    const secondPersonal = concurrentPersonal(); assert.equal((await bothPaused)[0], "both-personal-paused");
    child.send("resume-first-personal");
    const firstPersonalResult = await firstPersonal; assert.equal(firstPersonalResult.status, 201);
    child.send("resume-personal-reads");
    const secondPersonalResult = await secondPersonal; assert.equal(secondPersonalResult.status, 200,
      "a stale empty owner lookup reopens the committed room instead of failing a slug precheck");
    const simultaneous = [firstPersonalResult, secondPersonalResult];
    const simultaneousRooms = await Promise.all(simultaneous.map(result => result.json() as Promise<{ room: { roomId: string } }>));
    assert.equal(simultaneousRooms[0]!.room.roomId, simultaneousRooms[1]!.room.roomId);
    assert.equal((await storage.listRooms()).filter(candidate => candidate.ownerParticipantId === simultaneousOwner).length, 1);
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAD0lEQVR4AWISW+z1H4QBAAAA///iIMP1AAAABklEQVQDAA/LBAeJ81I+AAAAAElFTkSuQmCC", "base64");
    const upload = async (filename: string, roomId = room.roomId) => {
      const form = new FormData(); form.set("document", new Blob([new Uint8Array(image)], { type: "image/png" }), filename);
      const result = await fetch(`${base}/api/rooms/${roomId}/documents`, { method: "POST", headers: admin, body: form });
      assert.equal(result.status, 201); return (await result.json() as { document: { documentId: string } }).document;
    };
    const doc = await upload("failed-cleanup.png");
    const deleteUrl = `${base}/api/rooms/${room.roomId}/documents/${doc.documentId}`;
    assert.equal((await fetch(deleteUrl, { method: "DELETE", headers })).status, 503);
    assert.ok((await storage.getRoomDocument(room.roomId, doc.documentId))!.deletedAt);
    assert.deepEqual(await storage.listRoomDocuments(room.roomId), []);
    assert.equal((await fetch(`${deleteUrl}/download`, { headers: admin })).status, 404);
    const stored = (await storage.getRoomDocument(room.roomId, doc.documentId))!;
    assert.deepEqual(await readFile(join(uploadRoot, stored.storageKey)), image);
    cleanupFails = false;
    probeFence = false;
    const repeated = await Promise.all([fetch(deleteUrl, { method: "DELETE", headers }), fetch(deleteUrl, { method: "DELETE", headers })]);
    assert.ok(repeated.every(r => r.status === 200));
    const fresh = await upload("concurrent-live-delete.png");
    const freshUrl = `${base}/api/rooms/${room.roomId}/documents/${fresh.documentId}`;
    const deleteCount = async () => {
      const result = await fetch(`${base}/metrics`);
      assert.equal(result.status, 200);
      const match = /^vrata_document_deletes_total (\d+)$/m.exec(await result.text());
      assert.ok(match); return Number(match[1]);
    };
    const before = await deleteCount();
    const armedDeletes = once(child, "message"); child.send({ arm: "delete-reads", documentId: fresh.documentId });
    assert.equal((await armedDeletes)[0], "delete-reads-armed");
    const paused = once(child, "message", { signal: AbortSignal.timeout(5000) });
    const initialDeletes = [fetch(freshUrl, { method: "DELETE", headers }), fetch(freshUrl, { method: "DELETE", headers })];
    assert.equal((await paused)[0], "delete-reads-paused", "both initial requests read the live document before the fence");
    child.send("resume-delete-reads");
    const initialResults = await Promise.all(initialDeletes);
    assert.ok(initialResults.every(result => result.status === 200));
    const deleted = (await storage.getRoomDocument(room.roomId, fresh.documentId))!;
    assert.ok(deleted.deletedAt);
    assert.equal(deleted.deletedBy, "legacy-host");
    assert.equal(await deleteCount(), before + 1);
    probeFence = true;
    const retry = await fetch(freshUrl, { method: "DELETE", headers }); assert.equal(retry.status, 200);
    const retried = (await storage.getRoomDocument(room.roomId, fresh.documentId))!;
    assert.equal(retried.deletedAt, deleted.deletedAt);
    assert.equal(retried.deletedBy, deleted.deletedBy);
    assert.equal(await deleteCount(), before + 1);
    const nextDoc = await upload("raise-during-cleanup.png");
    const blockedDoc = await upload("raise-before-tombstone.png", blockedRoom.roomId);
    const blockedUrl = `${base}/api/rooms/${blockedRoom.roomId}/documents/${blockedDoc.documentId}`;
    const nextUrl = `${base}/api/rooms/${room.roomId}/documents/${nextDoc.documentId}`;
    const armedReopen = once(child, "message"); child.send("arm-reopen"); assert.equal((await armedReopen)[0], "reopen-armed");
    const preparing = once(child, "message");
    const reopened = personal(); assert.equal((await preparing)[0], "reopen-prepared");
    const armedBody = once(child, "message"); child.send("arm-body"); assert.equal((await armedBody)[0], "body-armed");
    const bodyWait = once(child, "message");
    const delayedOwner = `after-${randomUUID()}`;
    let complete!: (value: { status: number; body: string }) => void;
    const delayedResponse = new Promise<{ status: number; body: string }>(resolve => { complete = resolve; });
    const body = JSON.stringify({ participantId: delayedOwner, displayName: "Late" });
    const outgoing = httpRequest(`${base}/api/personal-room`, { method: "POST", headers: { "content-type": "application/json" } }, result => {
      let text = ""; result.on("data", chunk => { text += String(chunk); }); result.on("end", () => complete({ status: result.statusCode ?? 0, body: text }));
    });
    outgoing.write(body.slice(0, -1)); assert.equal((await bodyWait)[0], "body-wait");
    const holder = await pool.connect();
    let blockedDelete: Promise<Response> | undefined;
    try {
      await holder.query("begin");
      await holder.query("select room_id from rooms where room_id=$1 for update", [blockedRoom.roomId]);
      const pid = (await holder.query("select pg_backend_pid() as pid")).rows[0].pid;
      blockedDelete = fetch(blockedUrl, { method: "DELETE", headers: { authorization: `Bearer ${hostToken(blockedRoom.roomId)}` } });
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        waiting = (await pool.query("select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as waiting", [pid])).rows[0].waiting;
        if (waiting) break;
        await delay(10);
      }
      assert.equal(waiting, true, "DELETE passed entry checks and waits for its parent-room fence");
      cleanupRaises = true;
      assert.equal((await fetch(nextUrl, { method: "DELETE", headers })).status, 200,
        "confirmed pre-cutover intent finishes cleanup after raise without holding a fence over RPC");
      const callsBeforeRelease = cleanupCalls;
      const deletesBeforeRelease = await deleteCount();
      await holder.query("commit");
      const denied = await blockedDelete;
      assert.equal(denied.status, 409);
      assert.equal((await denied.json() as { reason: string }).reason, "identity_upgrade_required");
      assert.equal((await storage.getRoomDocument(blockedRoom.roomId, blockedDoc.documentId))!.deletedAt, null);
      assert.equal((await storage.listRoomDocuments(blockedRoom.roomId)).length, 1);
      assert.equal(cleanupCalls, callsBeforeRelease);
      assert.equal(await deleteCount(), deletesBeforeRelease);
    } finally {
      await holder.query("rollback").catch(() => undefined); holder.release();
      if (blockedDelete) await blockedDelete.catch(() => undefined);
    }
    child.send("resume"); outgoing.end(body.slice(-1));
    const reopenedResult = await reopened; assert.equal(reopenedResult.status, 409);
    const reopenedBody = await reopenedResult.json() as { roomId?: string; roomLink?: string; reason: string };
    assert.equal(reopenedBody.reason, "identity_upgrade_required"); assert.equal(reopenedBody.roomId, undefined); assert.equal(reopenedBody.roomLink, undefined);
    assert.equal((await delayedResponse).status, 409);
    assert.equal((await storage.listRooms()).some(r => r.ownerParticipantId === delayedOwner), false);
    assert.ok(await storage.getRoom(existing.room.roomId));
    const calls = cleanupCalls;
    assert.equal((await fetch(nextUrl, { method: "DELETE", headers })).status, 409);
    assert.equal(cleanupCalls, calls);
    assert.equal((await fetch(nextUrl, { method: "DELETE", headers: admin })).status, 200);
    assert.deepEqual(cleanupIssues, []);
    const armedOwned = once(child, "message"); child.send("arm-owned-failure"); assert.equal((await armedOwned)[0], "owned-failure-armed");
    const unavailable = await fetch(`${base}/api/personal-room`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ identityProtocolVersion: 2, displayName: "Unconfirmed" }) });
    assert.equal(unavailable.status, 503);
    const unavailableBody = await unavailable.json() as { error: string; identityCredential?: string };
    assert.equal(unavailableBody.error, "identity_authority_unavailable"); assert.equal(unavailableBody.identityCredential, undefined);
    const beforeFailure = await failures();
    const armedRooms = once(child, "message"); child.send("arm-room-failure"); assert.equal((await armedRooms)[0], "room-failure-armed");
    const failedList = await fetch(`${base}/api/rooms`);
    assert.equal(failedList.status, 500);
    assert.equal((await failedList.json() as { error: string }).error, "internal_error");
    assert.equal(await failures(), beforeFailure + 1, "unrelated pool errors retain request failure accounting");
  } finally {
    child.send("resume-personal-reads");
    child.send("resume-delete-reads");
    child.send("resume");
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
    state.closeAllConnections(); await new Promise<void>(resolve => state.close(() => resolve()));
    await rm(uploadRoot, { recursive: true, force: true });
  }
});
