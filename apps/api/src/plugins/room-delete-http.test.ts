import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, "exit"); child.kill("SIGTERM"); await done;
}
test("room DELETE keeps normal rooms storage-config independent, reports business/IO correctly and rethrows sanitized request failures", { timeout: 60_000 }, async t => {
  const reserve = createServer(); reserve.listen(0, "127.0.0.1"); await once(reserve, "listening");
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const script = `
    const {once}=await import('node:events');
    const {MemoryStorage}=await import(${JSON.stringify(new URL("../storage.js", import.meta.url).href)});
    const {RoomPluginStorageError}=await import(${JSON.stringify(new URL("./contracts.js", import.meta.url).href)});
    const {RoomPluginOperationPending}=await import(${JSON.stringify(new URL("./package-service.js", import.meta.url).href)});
    const {RoomPluginBlobIoError}=await import(${JSON.stringify(new URL("./blob-errors.js", import.meta.url).href)});
    const {RoomFenceCommitUncertain}=await import(${JSON.stringify(new URL("../identity/fence-transaction.js", import.meta.url).href)});
    const original=MemoryStorage.prototype.deleteRoom; let mode='normal';
    MemoryStorage.prototype.deleteRoom=async function(...args){
      if(mode==='missing')throw new RoomPluginStorageError('room_not_found');
      if(mode==='business')throw new RoomPluginStorageError('plugin_upload_pending');
      if(mode==='pending')throw new RoomPluginOperationPending('private-package',new Error('secret-do-not-publish'));
      if(mode==='blob')throw new RoomPluginBlobIoError('delete',new Error('secret-do-not-publish'));
      if(mode==='commit')throw new RoomFenceCommitUncertain(new Error('secret-do-not-publish'));
      if(mode==='database'||mode==='config')throw new Error('secret-do-not-publish');
      return original.apply(this,args);
    };
    process.on('message',next=>{mode=next;process.send(next)});
    const {startApiServer}=await import(${JSON.stringify(new URL("../index.js", import.meta.url).href)});
    const server=startApiServer(${port}); await once(server,'listening'); process.send('ready');
  `;
  let logs = "";
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, POSTGRES_URL: "", NODE_ENV: "test", VRATA_DISABLE_AUTOSTART: "1", NOAH_DISABLE_AUTOSTART: "1",
      CONTROL_PLANE_ADMIN_TOKEN: "plugin-delete-http-admin", STATE_TOKEN_SECRET: "plugin-delete-http-secret-32-characters",
      DOCUMENT_PROVIDER: "invalid-do-not-resolve", ROOM_PLUGIN_LOCAL_UPLOAD_ROOT: "/not-needed-for-ordinary-room" } });
  child.stdout?.on("data", value => { logs += String(value); }); child.stderr?.on("data", value => { logs += String(value); });
  t.after(() => stop(child));
  const message = (expected: string) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.off("message", listen); reject(new Error(`child_wait_failed:${expected}:${logs}`)); }, 10_000);
    const listen = (value: unknown) => { if (value === expected) { clearTimeout(timer); child.off("message", listen); resolve(); } };
    child.on("message", listen);
  });
  await message("ready");
  const base = `http://127.0.0.1:${port}`;
  const headers = { "content-type": "application/json", "x-vrata-admin-token": "plugin-delete-http-admin" };
  for (const [mode, status, error] of [["normal", 200, undefined], ["missing", 404, "room_not_found"], ["business", 409, "plugin_upload_pending"],
    ["pending", 503, "plugin_operation_pending"], ["blob", 503, "room_plugin_cleanup_unavailable"],
    ["database", 500, "internal_error"], ["commit", 500, "internal_error"], ["config", 500, "internal_error"]] as const) {
    const created = await fetch(`${base}/api/rooms`, { method: "POST", headers,
      body: JSON.stringify({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Delete error contract" }), signal: AbortSignal.timeout(10_000) });
    assert.equal(created.status, 201);
    const room = await created.json() as { roomId: string };
    const ack = message(mode); child.send(mode); await ack;
    const response = await fetch(`${base}/api/rooms/${room.roomId}`, { method: "DELETE", headers, signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, status, mode);
    const body = await response.json() as { error?: string; ok?: boolean };
    if (error) assert.deepEqual(body, { error }); else assert.equal(body.ok, true);
    assert.equal(JSON.stringify(body).includes("secret-do-not-publish"), false);
  }
  await delay(20);
  assert.ok(logs.includes('"event":"request_failed"'), "unrelated failures must reach the normal request-failure path");
  assert.equal(logs.includes("secret-do-not-publish"), false);
});
