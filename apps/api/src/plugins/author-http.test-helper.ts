import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { request as httpRequest, type ClientRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { createRoomPluginArtifact, validateRoomPluginArtifact } from "@vrata/room-plugin-sdk/artifact";
import type { RoomPluginManifest } from "@vrata/room-plugin-sdk";
import { PostgresStorage } from "../storage.js";
import type { RoomRecord } from "../storage-contracts.js";

// Fixed fixtures, not deployment credentials. Never include child logs or request credentials in errors.
export const AUTHOR_HTTP_SECRET = "author-http-isolated-fixture-secret-32-bytes";
export const AUTHOR_HTTP_SOURCE = "export function init() { /* PRIVATE-AUTHOR-HTTP-SOURCE */ }";
export const AUTHOR_HTTP_CONFIG = "PRIVATE-AUTHOR-HTTP-CONFIG";
const administrator = "author-http-isolated-administrator";

export interface AuthorHttpResponse {
  status: number;
  headers: Record<string, string>;
  bytes: Buffer;
  json<T = Record<string, unknown>>(): T;
}
export interface AuthorHttpSession {
  token: string;
  identityCredential: string;
  participantId: string;
  role: string;
  isOwner: boolean;
}
export interface AuthorHttpRoom { room: RoomRecord; host: AuthorHttpSession }
export interface AuthorHttpPackage {
  packageId: string; pluginId: string; version: string; artifactSha256: string;
  byteLength: number; manifest: RoomPluginManifest; state: string; uploadSettled: boolean;
}
type Phase = "body-admitted" | "body-end" | "put-written" | "upload-settled" | "private-read" | "plugin-room" | "settlement-timeout"
  | "telemetry-effect" | "telemetry-written" | "telemetry-read" | "telemetry-ack-loss" | "room-read" | "room-loaded"
  | "administrative-insert" | "administrative-receipt" | "administrative-ack-loss" | "state-token-ack-loss" | "legacy-state-token-ack-loss"
  | "admission-write" | "admission-written" | "admission-ack-loss";
type Message = { event?: string; phase?: Phase; id?: string; command?: string; kind?: Phase; roomId?: string; offset?: number; operation?: string;
  skip?: number; sqlState?: "55P03"; lockTimeoutMs?: number };

export function authorHttpArtifact(id = "http-status", version = "1.0.0", entry = AUTHOR_HTTP_SOURCE,
  capabilities: RoomPluginManifest["requestedCapabilities"] = ["status.set"]) {
  return createRoomPluginArtifact({ schemaVersion: 1, sdkApiVersion: 1, id, version, displayName: "HTTP fixture",
    requestedCapabilities: capabilities, configSchema: { label: { type: "string", required: false, minLength: 0, maxLength: 4096 } } }, entry);
}
export function authorHttpBinding(value: AuthorHttpPackage, expectedRevision = 0, overrides: Record<string, unknown> = {}) {
  return { expectedRevision, packageId: value.packageId, version: value.version, artifactSha256: value.artifactSha256,
    enabled: true, config: { label: AUTHOR_HTTP_CONFIG }, approvedCapabilities: ["status.set"], ...overrides };
}
export const authorHttpPath = (roomId: string, suffix: string) => `/api/rooms/${encodeURIComponent(roomId)}/plugins/${suffix}`;
export const authorHttpBearer = (token: string) => ({ authorization: `Bearer ${token}` });

export function assertAuthorHttpDenied(value: AuthorHttpResponse, status: number, error: string, reason?: string): void {
  assert.equal(value.status, status, `expected ${error}; received HTTP ${value.status}`);
  assert.deepEqual(value.json(), { error, ...(reason === undefined ? {} : { reason }) });
  for (const header of ["content-disposition", "x-artifact-sha256", "etag"]) assert.equal(value.headers[header], undefined);
  const body = value.bytes.toString("utf8");
  for (const privateValue of [AUTHOR_HTTP_SOURCE, AUTHOR_HTTP_CONFIG, AUTHOR_HTTP_SECRET, administrator,
    "storageKey", "backendFingerprint", "room-plugins/", "identityCredential", "rs2."]) {
    assert.equal(body.includes(privateValue), false, "refusal must not echo private values or success metadata");
  }
}
export function assertAuthorHttpPublicDto(value: unknown, forbidden: string[] = []): void {
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      assert.equal(/storage.?key|backend.?fingerprint|credential|secret|password|access.?key|tenantId|roomId/i.test(key), false,
        `private DTO field: ${key}`);
      walk(child);
    }
  };
  walk(value);
  const text = JSON.stringify(value);
  for (const item of [AUTHOR_HTTP_SECRET, AUTHOR_HTTP_SOURCE, administrator, "rs2.", "ri2.", "room-plugins/", ...forbidden]) {
    assert.equal(text.includes(item), false, "DTO must not include private storage or authentication values");
  }
}

/** All instrumentation is confined to this child. IPC messages contain phase IDs only, never HTTP values.
 * Plugin SQL pauses occur after acknowledged COMMIT or before the parent lock.
 * telemetry-written deliberately pauses before COMMIT while holding the room fence.
 * telemetry-effect also pauses legacy and virtual effects and the legacy credential release at entry; room-read/room-loaded bracket a room lookup.
 * telemetry-ack-loss lets the mapped transaction's real COMMIT run, then drops only its acknowledgement.
 * state-token-ack-loss does the same for the virtual scope that read the armed room's authority row.
 * legacy-state-token-ack-loss does the same for the persisted fence that read it by (tenant, room).
 * admission-write holds the guarded floor-1 admission write at entry, after its plan and before its transaction.
 * admission-written holds it after its actual seat UPDATE or pending INSERT returned, its locks still held.
 * admission-ack-loss lets that write's real COMMIT run on the same client, then drops only its acknowledgement.
 * x-author-hold-state-reply queues only a state-token or session-control reply's end() until flush-state-replies.
 * Held phases resume in FIFO order, so one case may hold several requests.
 * The local reader currently uses FileHandle; readFile is also wrapped for the equivalent buffered path.
 */
function childInstrumentation(indexUrl: string, telemetryCheckpoints: boolean, administrativeCheckpoints: boolean): string {
  return `
    import {IncomingMessage,ServerResponse} from 'node:http';
    import {syncBuiltinESMExports} from 'node:module';
    import fs from 'node:fs/promises';
    import pg from 'pg';
    let offset=0, armed;
    const resumes=[];
    const heldReplies=[];
    const originalNow=Date.now;
    Date.now=()=>originalNow()+offset;
    const notify=value=>process.send?.(value);
    const pause=async(kind,roomId,details={})=>{
      if(!armed || armed.kind!==kind || armed.roomId!==roomId) return;
      if(armed.skip>0){--armed.skip;return;}
      const id=armed.id;armed=undefined;
      await new Promise(resolve=>{resumes.push(resolve);notify({event:'phase',phase:kind,id,...details});});
    };
    process.on('message',message=>{
      if(message.command==='arm'){armed=message;notify({event:'ack',id:message.id});}
      if(message.command==='resume'){resumes.shift()?.();notify({event:'ack',id:message.id});}
      if(message.command==='clock'){offset=message.offset;notify({event:'ack',id:message.id});}
      if(message.command==='sync'){notify({event:'ack',id:message.id});}
      if(message.command==='flush-state-replies'){
        // A destroyed socket rejects the late end; the parent observes that through its own request.
        for(const flush of heldReplies.splice(0)){try{flush();}catch{}}
        notify({event:'ack',id:message.id});
      }
    });
    const on=IncomingMessage.prototype.on;
    IncomingMessage.prototype.on=function(event,...args){
      const result=on.call(this,event,...args), id=this.headers?.['x-author-http-phase'];
        if(id && event==='end' && (this.url?.includes('/plugins/') || (${telemetryCheckpoints} && (this.url?.includes('/diagnostics') || this.url?.includes('/xr-telemetry') || this.url==='/api/tokens/state')) || (${administrativeCheckpoints} && this.url==='/api/rooms'))){
        notify({event:'phase',phase:'body-admitted',id});
        on.call(this,'end',()=>notify({event:'phase',phase:'body-end',id}));
      }
      return result;
    };
    const query=pg.Client.prototype.query;
    const settlements=new WeakMap();
    const creations=new WeakMap();
    const lockTimeouts=new WeakMap();
    const ackLosses=new WeakSet();
    const pinAckLosses=new WeakMap();
    const admissionScopes=new WeakMap();
    const admissionAckLosses=new WeakMap();
    pg.Client.prototype.query=async function(sql,...args){
      const text=typeof sql==='string'?sql:sql?.text;
      const values=Array.isArray(args[0])?args[0]:sql?.values;
      const pluginParent=/^select room_type,status,disabled_at,session_control from rooms/.test(text??'');
      if(pluginParent){
        await pause('plugin-room',values?.[1]);
      }
      let result;
      try { result=await query.call(this,sql,...args); }
      catch(error){
        // Observe the actual PostgreSQL ErrorResponse. Preserve its original class/code for production retry policy.
        if(pluginParent && error instanceof pg.DatabaseError && error.severity==='ERROR' && error.code==='55P03'){
          await pause('settlement-timeout',values?.[1],{sqlState:'55P03',lockTimeoutMs:lockTimeouts.get(this)});
        }
        throw error;
      }
      if(text?.startsWith("select set_config('lock_timeout',")) lockTimeouts.set(this,Number.parseInt(values?.[0],10));
      if(/update room_plugin_packages set upload_settled=true/.test(text??'')) settlements.set(this,values?.[1]);
      // The virtual pin reads the authority row by room; the persisted fence reads it by (tenant, room).
      const pinned=text==='select 1 from room_identity_authority_v2 where room_id=$1'?['state-token-ack-loss',values?.[0]]
        :text==='select 1 from room_identity_authority_v2 where tenant_id=$1 and room_id=$2'?['legacy-state-token-ack-loss',values?.[1]]:undefined;
      if(pinned && armed?.kind===pinned[0] && armed.roomId===pinned[1]){
        pinAckLosses.set(this,{phase:pinned[0],id:armed.id});armed=undefined;
      }
      // The guarded admission write reads the authority row by (tenant, room), then runs its one write on that same client.
      if(pinned?.[0]==='legacy-state-token-ack-loss') admissionScopes.set(this,values?.[1]);
      const scope=admissionScopes.get(this);
      if(scope!==undefined && scope===values?.[1] && (/^\\s*update\\s+rooms\\s+set\\s+session_control\\s*=\\s*session_control\\s*[|][|]\\s*jsonb_build_object[(]\\s*'hostParticipantId'/i.test(text??'')
        || /^\\s*insert\\s+into\\s+room_waiting_requests\\s*[(][^)]*[)]\\s*values\\s*[(][^)]*[)]\\s*on\\s+conflict\\s*[(]\\s*invite_id\\s*,\\s*participant_id\\s*[)]\\s*do\\s+nothing/i.test(text??''))){
        if(armed?.kind==='admission-ack-loss' && armed.roomId===scope){admissionAckLosses.set(this,armed.id);armed=undefined;}
        await pause('admission-written',scope);
      }
      if(${administrativeCheckpoints} && text?.trimStart().startsWith('insert into rooms (')){
        creations.set(this,values?.[0]);await pause('administrative-insert',values?.[0]);
      }
      if(/^commit$/i.test(text??'') && creations.has(this)){
        const roomId=creations.get(this);creations.delete(this);
        if(armed?.kind==='administrative-ack-loss' && armed.roomId===roomId){armed=undefined;throw new Error('fixture_create_commit_ack_lost');}
      }
      if(/^commit$/i.test(text??'') && settlements.has(this)){
        const roomId=settlements.get(this);settlements.delete(this);
        await pause('upload-settled',roomId);
      }
      if(/^commit$/i.test(text??'') && ackLosses.has(this)){ackLosses.delete(this);throw new Error('fixture_telemetry_commit_ack_lost');}
      if(/^commit$/i.test(text??'') && pinAckLosses.has(this)){
        const {phase,id}=pinAckLosses.get(this);pinAckLosses.delete(this);
        notify({event:'phase',phase,id});throw new Error('fixture_state_token_commit_ack_lost');
      }
      if(/^commit$/i.test(text??'') && admissionAckLosses.has(this)){
        const id=admissionAckLosses.get(this);admissionAckLosses.delete(this);admissionScopes.delete(this);
        notify({event:'phase',phase:'admission-ack-loss',id});throw new Error('fixture_admission_commit_ack_lost');
      }
      if(/^(commit|rollback)$/i.test(text??'')) admissionScopes.delete(this);
      if(/^rollback$/i.test(text??'')){settlements.delete(this);creations.delete(this);ackLosses.delete(this);pinAckLosses.delete(this);admissionAckLosses.delete(this);}
      return result;
    };
    const root=process.env.ROOM_PLUGIN_LOCAL_UPLOAD_ROOT;
    const privatePath=value=>typeof value==='string' && value.startsWith(root+'/room-plugins/');
    const roomAt=value=>Buffer.from(value.slice(root.length+1).split('/')[2]??'','hex').toString('utf8');
    const io=operation=>notify({event:'io',operation});
    const read=fs.readFile,open=fs.open,link=fs.link,remove=fs.rm;
    fs.readFile=async function(path,...args){
      const bytes=await read.call(this,path,...args);
      if(privatePath(path)){io('read');await pause('private-read',roomAt(path));}
      return bytes;
    };
    fs.open=async function(path,flags,...args){
      const file=await open.call(this,path,flags,...args);
      if(privatePath(path) && flags==='r' && path.endsWith('.vrata-plugin.json')){
        io('read');const close=file.close.bind(file);
        file.close=async()=>{await close();await pause('private-read',roomAt(path));};
      }
      return file;
    };
    fs.link=async function(source,target){
      const result=await link.call(this,source,target);
      if(privatePath(target)){io('put');await pause('put-written',roomAt(target));}
      return result;
    };
    fs.rm=async function(path,...args){
      if(privatePath(path))io(path.endsWith('.upload')?'temp-delete':'delete');
      return remove.call(this,path,...args);
    };
    syncBuiltinESMExports();
    if(${administrativeCheckpoints}){
      const {PostgresStorage}=await import(${JSON.stringify(new URL("storage.js", indexUrl).href)});
      const create=PostgresStorage.prototype.createAdministrativeRoom;
      PostgresStorage.prototype.createAdministrativeRoom=async function(...args){
        const room=await create.apply(this,args);await pause('administrative-receipt',room.roomId);return room;
      };
    }
    if(${telemetryCheckpoints}){
      // Emulate a backpressured reply: queue only the marked state-token or session-control end() after writeHead.
      const holdable=req=>(req.method==='POST' && req.url==='/api/tokens/state')
        || (req.method==='GET' && /^[/]api[/]rooms[/][^/?]+[/]session-control$/.test(req.url??''));
      const end=ServerResponse.prototype.end;
      ServerResponse.prototype.end=function(...args){
        const id=this.req?.headers?.['x-author-hold-state-reply'];
        if(typeof id!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
          || !holdable(this.req)) return end.apply(this,args);
        heldReplies.push(()=>end.apply(this,args));notify({event:'state-reply-buffered',id});return this;
      };
      // Relay only a validated correlation UUID; raw diagnostic logs stay unrecorded.
      const write=process.stdout.write;
      process.stdout.write=function(chunk,...args){
        if(typeof chunk==='string') try{
          const event=JSON.parse(chunk);
          if(event.event==='runtime_diagnostic_report' && typeof event.requestId==='string'
            && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.requestId)) notify({event:'diagnostic-published',id:event.requestId});
        }catch{}
        return write.call(this,chunk,...args);
      };
      const {PostgresStorage}=await import(${JSON.stringify(new URL("storage.js", indexUrl).href)});
      const effect=PostgresStorage.prototype.withRoomIdentityEffect;
      PostgresStorage.prototype.withRoomIdentityEffect=async function(guard,...args){
        await pause('telemetry-effect',guard.roomId);return effect.call(this,guard,...args);
      };
      for(const method of ['withLegacyRoomEffect','withLegacyVirtualRoomEffect','releaseLegacyRoomCredential']){
        const original=PostgresStorage.prototype[method];
        PostgresStorage.prototype[method]=async function(scope,...args){
          await pause('telemetry-effect',typeof scope==='string'?scope:scope?.roomId);return original.call(this,scope,...args);
        };
      }
      // A separate entry hold: telemetry-effect still pauses only the read-only release after a known admission COMMIT.
      const admit=PostgresStorage.prototype.writeLegacyAdmission;
      PostgresStorage.prototype.writeLegacyAdmission=async function(input,...args){
        await pause('admission-write',input?.selector?.roomId);return admit.call(this,input,...args);
      };
      const loadRoom=PostgresStorage.prototype.getRoom;
      PostgresStorage.prototype.getRoom=async function(roomId,...args){
        await pause('room-read',roomId);const room=await loadRoom.call(this,roomId,...args);await pause('room-loaded',roomId);return room;
      };
      for(const method of ['addDiagnostic','addXrTelemetry','getXrTelemetry']){
        const original=PostgresStorage.prototype[method];
        PostgresStorage.prototype[method]=async function(roomId,...args){
          if(method!=='getXrTelemetry' && !this.effectRoomWrite) throw new Error('telemetry_fixture_requires_upfront_write_mode');
          const result=await original.call(this,roomId,...args);
          if(method!=='getXrTelemetry' && armed?.kind==='telemetry-ack-loss' && armed.roomId===roomId){armed=undefined;ackLosses.add(this.effectClient);}
          await pause(method==='getXrTelemetry'?'telemetry-read':'telemetry-written',roomId);return result;
        };
      }
    }
    await import(${JSON.stringify(indexUrl)});
  `;
}

export async function startAuthorHttpFixture(t: TestContext, floor: 1 | 2 = 2, telemetryCheckpoints = false, administrativeCheckpoints = false) {
  assert.ok(process.env.VRATA_TEST_POSTGRES_URL, "VRATA_TEST_POSTGRES_URL is required (including CI)");
  const schema = `plugin_author_http_${randomUUID().replaceAll("-", "")}`;
  const rootPool = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL });
  const localRoot = await mkdtemp(join(tmpdir(), "vrata-author-http-private-"));
  const connection = new URL(process.env.VRATA_TEST_POSTGRES_URL);
  connection.searchParams.set("options", `-c search_path=${schema},public`);
  connection.searchParams.set("application_name", schema);
  const pool = new Pool({ connectionString: connection.href });
  let child: ReturnType<typeof spawn> | undefined;
  let createdSchema = false;
  let sharedFloor: number | null = null;
  async function stopOwnedApiChild(owned: ReturnType<typeof spawn>): Promise<void> {
    if (owned.exitCode !== null || owned.signalCode !== null) return;
    const trackedPid = owned.pid;
    assert.ok(trackedPid && trackedPid > 0, "only the tracked API spawn may be stopped");
    const exited = once(owned, "exit");
    // ChildProcess.kill targets this tracked PID only, never a process group or a shared service.
    owned.kill("SIGTERM");
    if (!await Promise.race([exited.then(() => true), delay(5000, undefined, { ref: false }).then(() => false)])) {
      if (owned.exitCode === null && owned.signalCode === null) owned.kill("SIGKILL");
      await exited;
    }
  }
  const readSharedFloor = async (): Promise<number | null> => {
    if (!(await rootPool.query("select to_regclass('public.room_identity_protocol_policy') as policy")).rows[0].policy) return null;
    return (await rootPool.query("select minimum_protocol from public.room_identity_protocol_policy where singleton=true")).rows[0]?.minimum_protocol ?? null;
  };
  t.after(async () => {
    if (child) await stopOwnedApiChild(child);
    await pool.end();
    if (createdSchema) await rootPool.query(`drop schema "${schema}" cascade`);
    try { assert.equal(await readSharedFloor(), sharedFloor, "owned v2 tests must not change the shared public policy floor"); }
    finally { await rootPool.end(); await rm(localRoot, { recursive: true, force: true }); }
  });
  sharedFloor = await readSharedFloor();
  assert.ok(sharedFloor === null || sharedFloor === 1, "the shared public schema must remain at floor one");
  await rootPool.query(`create schema "${schema}"`); createdSchema = true;
  const storage = new PostgresStorage(pool); await storage.init();
  const resolvedPolicy = (await pool.query(`select current_schema() as schema,n.nspname as policy_schema
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.oid='room_identity_protocol_policy'::regclass`)).rows[0];
  assert.deepEqual(resolvedPolicy, { schema, policy_schema: schema }, "floor activation must target ONLY the freshly owned schema");
  assert.equal(await storage.identityProtocol.minimum(), 1);
  if (floor === 2) await storage.identityProtocol.raise(2);

  const reserve = createServer(); reserve.listen(0, "127.0.0.1"); await once(reserve, "listening");
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(ROOM_PLUGIN_|DOCUMENT_|SCENE_BUNDLE_|MINIO_|LIVEKIT_|ROOM_STATE_|REMOTE_BROWSER_)/.test(key)) delete env[key];
  }
  Object.assign(env, { NODE_ENV: "development", POSTGRES_URL: connection.href, API_PORT: String(port),
    STATE_TOKEN_SECRET: AUTHOR_HTTP_SECRET, CONTROL_PLANE_ADMIN_TOKEN: administrator,
    ROOM_PLUGIN_LOCAL_UPLOAD_ROOT: localRoot, DOCUMENT_LOCAL_UPLOAD_ROOT: localRoot,
    ROOM_ACCESS_POLICY_ENABLED: "true", FEATURE_HOST_CONTROLS: "true", FEATURE_PERSONAL_ROOMS: "true",
    FEATURE_ROOM_STATE_REALTIME: "false", FEATURE_REMOTE_BROWSER: "false",
    VRATA_DISABLE_AUTOSTART: "0", NOAH_DISABLE_AUTOSTART: "0", API_CORS_ORIGIN: "https://author-http.invalid" });
  const messages: Message[] = [];
  const io: string[] = [];
  function spawnOwnedApiChild() {
    const owned = spawn(process.execPath, ["--input-type=module", "-e", childInstrumentation(new URL("../index.js", import.meta.url).href, telemetryCheckpoints, administrativeCheckpoints)], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)), env, stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    child = owned;
    // Consume logs without printing tokens, invitation URLs, headers or SQL values on failures.
    owned.stdout!.resume(); owned.stderr!.resume();
    owned.on("message", value => {
      if (child !== owned) return;
      const message = value as Message;
      if (message.event === "io") io.push(message.operation!);
      else messages.push(message);
    });
    return owned;
  }
  async function waitMessage(event: string, id: string, phase?: Phase): Promise<Message> {
    let found: Message | undefined;
    await until(async () => {
      assert.equal(child!.exitCode, null, "isolated API child exited");
      const index = messages.findIndex(message => message.event === event && message.id === id && (!phase || message.phase === phase));
      if (index < 0) return false;
      [found] = messages.splice(index, 1); return true;
    }, `missing child checkpoint: ${phase ?? event}`);
    assert.ok(found); return found;
  }
  async function control(command: string, extra: Partial<Message> = {}) {
    const id = randomUUID(); child!.send({ command, id, ...extra }); await waitMessage("ack", id); return id;
  }
  const base = `http://127.0.0.1:${port}`;
  async function waitForApi() {
    await until(async () => {
      assert.equal(child!.exitCode, null, "isolated API child failed to start");
      assert.equal(child!.signalCode, null, "isolated API child stopped during startup");
      return fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) }).then(response => response.ok).catch(() => false);
    }, "isolated API health", 15_000);
  }
  spawnOwnedApiChild(); await waitForApi();
  async function restartApi() {
    const previous = child;
    assert.ok(previous?.pid, "restart requires this fixture's tracked API child");
    const previousPid = previous.pid;
    await stopOwnedApiChild(previous);
    assert.ok(previous.exitCode !== null || previous.signalCode !== null, "old API must be gone before restarting");
    messages.length = 0;
    // Reuse the exact schema, private root, port and signing secret. No fixture reinitialization or floor raise.
    const restarted = spawnOwnedApiChild(); await waitForApi();
    assert.ok(restarted.pid); assert.notEqual(restarted.pid, previousPid);
    return { previousPid, currentPid: restarted.pid };
  }

  function request(path: string, method = "GET", headers: Record<string, string> = {}, body?: unknown): Promise<AuthorHttpResponse> {
    return fetch(`${base}${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: body instanceof Uint8Array ? new Uint8Array(body) : JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000) }).then(async response => capture(response.status, Object.fromEntries(response.headers), Buffer.from(await response.arrayBuffer())));
  }
  const adminHeaders = { "x-vrata-admin-token": administrator };
  async function invite(roomId: string, role = "member", waitingRoomEnabled = false) {
    const response = await request(`/api/rooms/${roomId}/invites`, "POST", adminHeaders, { role, waitingRoomEnabled, expiresInSeconds: 3600 });
    assert.equal(response.status, 201, "fixture invitation must be issued over HTTP");
    const value = response.json<{ inviteId: string; inviteLink: string }>();
    const inviteToken = new URL(value.inviteLink).searchParams.get("invite");
    assert.ok(inviteToken, "invite response must contain its real redemption link");
    return { inviteId: value.inviteId, inviteToken };
  }
  async function admit(roomId: string, payload: Record<string, unknown> = {}) {
    return request("/api/tokens/state", "POST", {}, { identityProtocolVersion: 2, roomId, displayName: "HTTP participant", ...payload });
  }
  async function session(roomId: string, role = "member") {
    const issued = await invite(roomId, role);
    const response = await admit(roomId, { inviteToken: issued.inviteToken });
    assert.equal(response.status, 200, "fixture identity must be admitted over the real token HTTP route");
    const value = response.json<AuthorHttpSession>(); assert.match(value.token, /^rs2\./); assert.equal(value.role, role);
    return { ...value, ...issued };
  }
  async function room(tenantId = "demo-tenant"): Promise<AuthorHttpRoom> {
    const response = await request("/api/rooms", "POST", adminHeaders, { tenantId, templateId: "meeting-room-basic",
      name: "Isolated author HTTP", visibility: "public", guestAllowed: true });
    assert.equal(response.status, 201, "fixture room must be created over HTTP");
    const room = response.json<RoomRecord>(); return { room, host: await session(room.roomId, "host") };
  }
  async function present(roomId: string, actor: AuthorHttpSession) {
    const response = await request(`/api/rooms/${roomId}/presence/${actor.participantId}`, "PUT", authorHttpBearer(actor.token),
      { participantId: actor.participantId, displayName: "HTTP participant", updatedAt: new Date().toISOString() });
    assert.equal(response.status, 200, "transition target needs real HTTP presence");
  }
  async function transition(f: AuthorHttpRoom, suffix: string, target?: AuthorHttpSession, actor = f.host) {
    if (target) await present(f.room.roomId, target);
    const authority = await storage.roomIdentities.authority(f.room);
    const response = await request(`/api/rooms/${f.room.roomId}/${suffix}`, "POST", authorHttpBearer(actor.token),
      { expectedRevision: authority!.revision, ...(target ? { participantId: target.participantId } : {}) });
    assert.equal(response.status, 200, "fixture authority transition must succeed over HTTP"); return response;
  }
  async function upload(f: AuthorHttpRoom, artifact = authorHttpArtifact(), actor = f.host) {
    const response = await request(authorHttpPath(f.room.roomId, "packages"), "POST", authorHttpBearer(actor.token), artifact.bytes);
    assert.equal(response.status, 201, "RS2 author fixture upload must succeed");
    const value = response.json<{ package: AuthorHttpPackage }>().package;
    assertAuthorHttpPublicDto(value, [localRoot, actor.token, actor.identityCredential]);
    assert.equal(value.artifactSha256, artifact.artifactSha256); assert.equal(value.byteLength, artifact.byteLength);
    return value;
  }
  async function bind(f: AuthorHttpRoom, value: AuthorHttpPackage, expectedRevision = 0, overrides: Record<string, unknown> = {}) {
    return request(authorHttpPath(f.room.roomId, `bindings/${value.pluginId}`), "PUT", authorHttpBearer(f.host.token), authorHttpBinding(value, expectedRevision, overrides));
  }
  async function files(current = localRoot): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) Object.assign(result, await files(path));
      else if (entry.isFile()) result[path.slice(localRoot.length + 1)] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
    return result;
  }
  async function snapshot(roomId: string) {
    await control("sync");
    const state = (await pool.query("select * from room_plugin_state where room_id=$1 order by tenant_id", [roomId])).rows;
    const packages = (await pool.query("select * from room_plugin_packages where room_id=$1 order by package_id", [roomId])).rows;
    const bindings = (await pool.query("select * from room_plugin_bindings where room_id=$1 order by plugin_id", [roomId])).rows;
    return { state, packages, bindings, files: await files(), io: [...io] };
  }
  async function arm(kind: Phase, roomId: string, skip = 0) { return control("arm", { kind, roomId, skip }); }
  async function diagnosticPublishedCount(requestId: string): Promise<number> {
    assert.equal(typeof requestId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId), true, "fixture correlation UUID required");
    await control("sync");
    return messages.filter(message => message.event === "diagnostic-published" && message.id === requestId).length;
  }
  function stalled(path: string, auth: string | Record<string, string>, body: Uint8Array, method = "POST", declared = true) {
    const id = randomUUID();
    let pending!: ClientRequest;
    const response = new Promise<AuthorHttpResponse>((resolve, reject) => {
      pending = httpRequest(`${base}${path}`, { method, headers: { ...(typeof auth === "string" ? authorHttpBearer(auth) : auth), "x-author-http-phase": id,
        "content-type": "application/octet-stream", ...(declared ? { "content-length": String(body.byteLength) } : {}) } }, response => {
        const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.on("error", reject);
        response.on("end", () => resolve(capture(response.statusCode ?? 0,
          Object.fromEntries(Object.entries(response.headers).filter(([, value]) => typeof value === "string")) as Record<string, string>, Buffer.concat(chunks))));
      });
      pending.setTimeout(15_000, () => pending.destroy(new Error("isolated HTTP request timed out")));
      pending.on("error", reject); pending.write(body.subarray(0, Math.max(1, body.byteLength - 1)));
    });
    // Attach immediately: cleanup must not turn a deliberately refused socket into an unhandled rejection.
    void response.catch(() => undefined);
    return { response, admitted: () => waitMessage("phase", id, "body-admitted"),
      ended: () => waitMessage("phase", id, "body-end"), finish: () => pending.end(body.subarray(body.byteLength - 1)),
      destroy: () => pending.destroy() };
  }
  async function held(roomId: string, pending: () => Promise<AuthorHttpResponse>, change: (client: PoolClient) => Promise<void>,
    afterRelease?: () => Promise<unknown>) {
    const holder = await pool.connect(); let response: Promise<AuthorHttpResponse> | undefined;
    try {
      await holder.query("begin"); await holder.query("select room_id from rooms where room_id=$1 for update", [roomId]);
      const pid = (await holder.query("select pg_backend_pid() as pid")).rows[0].pid;
      response = pending(); void response.catch(() => undefined);
      await until(async () => (await pool.query(`select exists(select 1 from pg_stat_activity
        where application_name=$2 and $1=any(pg_blocking_pids(pid))) as blocked`, [pid, schema])).rows[0].blocked,
      "plugin final parent lock must be blocked, not merely scheduled");
      await change(holder); await holder.query("commit"); await afterRelease?.(); return await response;
    } finally { await holder.query("rollback").catch(() => undefined); holder.release(); if (response) await response.catch(() => undefined); }
  }
  return { schema, pool, storage, localRoot, base, io, adminHeaders, request, invite, admit, session, room, present, transition,
    upload, bind, files, snapshot, stalled, held, arm, restartApi, phase: (id: string, kind: Phase) => waitMessage("phase", id, kind),
    resume: () => control("resume"), clock: (offset: number) => control("clock", { offset }), diagnosticPublishedCount,
    stateReplyBuffered: (id: string) => waitMessage("state-reply-buffered", id), flushStateReplies: () => control("flush-state-replies") };
}

function capture(status: number, headers: Record<string, string>, bytes: Buffer): AuthorHttpResponse {
  return { status, headers, bytes, json: <T>() => JSON.parse(bytes.toString("utf8")) as T };
}
export async function until(probe: () => Promise<boolean>, description: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await probe()) return; await delay(10); }
  assert.fail(description);
}
export function uncheckedAuthorHttpArtifact(entry: string): Uint8Array {
  const value = authorHttpArtifact();
  return Buffer.from(JSON.stringify({ manifest: { ...value.artifact.manifest,
    entrySha256: createHash("sha256").update(entry).digest("hex") }, entry }));
}
export function exactSizeAuthorHttpArtifact(byteLength: number): Uint8Array {
  const value = authorHttpArtifact();
  assert.ok(byteLength >= value.byteLength);
  const bytes = Buffer.concat([Buffer.from(value.bytes), Buffer.alloc(byteLength - value.byteLength, 32)]);
  assert.equal(validateRoomPluginArtifact(bytes).byteLength, byteLength); return bytes;
}
