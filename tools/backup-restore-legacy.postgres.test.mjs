import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { createBackupManifest, inspectRestoreDump, main } from "./backup-restore.mjs";

const fixtureFile = process.env.VRATA_TEST_BACKUP_LEGACY_FIXTURE_JSON;
const baseline = "81c14b6ac8dbc537892f7b1f342ca8f718fdf0a6";
function canonicalPolicy(text) {
  // MinIO/mc can serialize equivalent policy statements in a different order on each read.
  const normalize = value => Array.isArray(value) ? value.map(normalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) :
    value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value;
  return JSON.stringify(normalize(JSON.parse(text)));
}
const snapshotProgram = `
import {Pool} from "pg"; import {createHash} from "node:crypto";
const pool=new Pool({connectionString:process.env.POSTGRES_URL,max:1});
try {
 const relations=(await pool.query("select c.oid,c.relname,c.relkind,c.relfilenode,c.reloptions,case when c.relkind in ('i','I') then pg_get_indexdef(c.oid) else null end as index_definition from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname")).rows;
 const indexes=(await pool.query("select i.* from pg_index i join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname")).rows;
 const constraints=(await pool.query("select c.oid,c.conname,c.conrelid,c.confrelid,c.conindid,pg_get_constraintdef(c.oid) as definition from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public' order by c.conrelid,c.conname")).rows;
 const rows={};for(const t of relations.filter(t=>t.relkind==='r'))rows[t.relname]=(await pool.query('select to_jsonb(t) as value from public."'+t.relname.replaceAll('"','""')+'" t order by to_jsonb(t)::text')).rows;
 const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 process.stdout.write(JSON.stringify({schemaHash:hash({relations,indexes,constraints}),dataHash:hash(rows),pluginTables:['room_plugin_bindings','room_plugin_packages','room_plugin_state'].filter(t=>rows[t]).length,packages:rows.room_plugin_packages?.length??0,bindings:rows.room_plugin_bindings?.length??0,state:rows.room_plugin_state?.length??0,pending:rows.room_plugin_packages?.filter(row=>row.value.state==='reserved'&&!row.value.upload_settled).length??0,scopeIndexPresent:relations.some(t=>t.relname==='rooms_identity_scope_idx')}));
} finally {await pool.end();}
`;
const seedProgram = `
import {Pool} from "pg"; import {createRoomPluginArtifact} from "@vrata/room-plugin-sdk/artifact";
import {PostgresStorage} from "./apps/api/dist/storage.js";
import {roomPluginUploadStorage} from "./apps/api/dist/plugins/blob-config.js";
import {createRoomPluginBlobStorage} from "./apps/api/dist/plugins/blob-storage.js";
import {createRoomPluginPackageService} from "./apps/api/dist/plugins/package-service.js";
import {randomUUID} from "node:crypto";
const pool=new Pool({connectionString:process.env.POSTGRES_URL,max:1});
try {
 const storage=new PostgresStorage(pool);const room=await storage.createRoom({tenantId:'demo-tenant',roomId:'legacy-private-'+randomUUID(),templateId:'meeting-room-basic',name:'Legacy restore privacy fixture',visibility:'private',guestAllowed:false});
 const scope={tenantId:room.tenantId,roomId:room.roomId}; const blobs=createRoomPluginBlobStorage(roomPluginUploadStorage('/app/apps/runtime-web/public'));
 const bytes=createRoomPluginArtifact({schemaVersion:1,sdkApiVersion:1,id:'legacy-backup-proof',version:'1.0.0',displayName:'Legacy proof',requestedCapabilities:['status.set'],configSchema:{}},'export function init() {}').bytes;
 const service=createRoomPluginPackageService(storage.roomPlugins,blobs);const pkg=await service.savePackage(scope,bytes);
 const bound=await storage.roomPlugins.putBinding(scope,pkg.pluginId,{packageId:pkg.packageId,version:pkg.version,artifactSha256:pkg.artifactSha256,enabled:true,config:{},approvedCapabilities:['status.set']},0);
 process.stdout.write(JSON.stringify({ready:pkg.state==='ready',binding:bound.bindings.length===1,signedExact:Buffer.from(await service.readPackage(scope,pkg.packageId)).equals(Buffer.from(bytes))}));
} finally {await pool.end();}
`;
const raceScope = "legacy-restore-race-owned-fixture";
const raceProgram = `
import {Pool} from "pg"; import {createRoomPluginArtifact} from "@vrata/room-plugin-sdk/artifact";
import {PostgresStorage} from "./apps/api/dist/storage.js";
import {roomPluginUploadStorage} from "./apps/api/dist/plugins/blob-config.js";
import {createRoomPluginBlobStorage} from "./apps/api/dist/plugins/blob-storage.js";
const pool=new Pool({connectionString:process.env.POSTGRES_URL,max:1});
try {
 const storage=new PostgresStorage(pool); if(await storage.getRoom('${raceScope}'))throw new Error('owned_race_fixture_collision');
 await storage.createRoom({tenantId:'demo-tenant',roomId:'${raceScope}',templateId:'meeting-room-basic',name:'Owned restore race',visibility:'private',guestAllowed:false});
 const blobs=createRoomPluginBlobStorage(roomPluginUploadStorage('/app/apps/runtime-web/public'));
 const bytes=createRoomPluginArtifact({schemaVersion:1,sdkApiVersion:1,id:'race-proof',version:'1.0.0',displayName:'Race proof',requestedCapabilities:[],configSchema:{}},'export function init() {}').bytes;
 const reservation=await storage.roomPlugins.reservePackage({tenantId:'demo-tenant',roomId:'${raceScope}'},bytes,blobs.backendFingerprint);
 // This fixture never starts PUT: the pending durable reservation alone must block legacy restore.
 process.stdout.write(JSON.stringify({reserved:reservation.package.state==='reserved',unsettled:!reservation.package.uploadSettled}));
} finally {await pool.end();}
`;
const raceCleanupProgram = `
import {Pool} from "pg"; import {PostgresStorage} from "./apps/api/dist/storage.js";
import {roomPluginUploadStorage} from "./apps/api/dist/plugins/blob-config.js";
import {createRoomPluginBlobStorage} from "./apps/api/dist/plugins/blob-storage.js";
import {deleteRoomWithPluginCleanup} from "./apps/api/dist/plugins/package-service.js";
const pool=new Pool({connectionString:process.env.POSTGRES_URL,max:1});
try {
 const storage=new PostgresStorage(pool),scope={tenantId:'demo-tenant',roomId:'${raceScope}'};
 const packages=await storage.roomPlugins.listPackages(scope);if(packages.length!==1||packages[0].state!=='reserved'||packages[0].uploadSettled)throw new Error('owned_race_cleanup_mismatch');
 // The fixture creator knows no PUT was ever started; only this owned reservation may be settled.
 await storage.roomPlugins.failPackageUpload(scope,packages[0].packageId);
 const blobs=createRoomPluginBlobStorage(roomPluginUploadStorage('/app/apps/runtime-web/public'));
 process.stdout.write(JSON.stringify({removed:await deleteRoomWithPluginCleanup(storage,scope,()=>blobs)}));
} finally {await pool.end();}
`;

test("real baseline81 legacy archive restores on empty T04 target atomically and refuses a live plugin target", {
  skip: !fixtureFile, timeout: 240_000
}, async () => {
  let fixture;
  try { fixture = JSON.parse(readFileSync(fixtureFile, "utf8")); }
  catch { throw new Error("legacy_fixture_invalid_json"); }
  const root = resolve(fixture.fixtureRoot), target = fixture.target;
  assert.ok(fixture.fixtureOnly === true && root.startsWith("/tmp/opencode/"));
  assert.ok([target.envFile, target.composeFile, fixture.legacyBackupDir].every(path => resolve(path).startsWith(`${root}/`)));
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(target.smokeBaseUrl).hostname));
  const compose = args => {
    try { return execFileSync("docker", ["compose", "--env-file", target.envFile, "-f", target.composeFile, ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 90_000, maxBuffer: 16 * 1024 * 1024 }); }
    catch { throw new Error("legacy_fixture_compose_command_failed"); }
  };
  const config = JSON.parse(compose(["config", "--format", "json"]));
  assert.ok(config.name.startsWith("vrata-backup-fixture-"));
  assert.ok(Object.values(config.volumes ?? {}).every(volume => !volume.external && volume.name.startsWith("vrata-backup-fixture-")));
  assert.ok(Object.values(config.services).every(service => (service.volumes ?? []).every(volume => volume.type !== "bind" || resolve(volume.source).startsWith(`${root}/`))));
  assert.equal(config.services.api.environment.MINIO_ENDPOINT, "http://minio:9000");
  assert.equal(config.services["minio-bootstrap"].environment.MINIO_ENDPOINT ?? "http://minio:9000", "http://minio:9000");
  const snapshot = () => JSON.parse(compose(["exec", "-T", "api", "node", "--input-type=module", "-e", snapshotProgram]));
  const policy = () => canonicalPolicy(compose(["run", "--rm", "--no-deps", "--entrypoint", "/bin/sh", "minio-bootstrap", "-lc",
    'mc alias set fixture http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc anonymous get-json "fixture/$ROOM_PLUGIN_BUCKET"']));
  const setPolicy = value => compose(["run", "--rm", "--no-deps", "--entrypoint", "/bin/sh", "minio-bootstrap", "-lc",
    `mc alias set fixture http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc anonymous set ${value} "fixture/$ROOM_PLUGIN_BUCKET" >/dev/null`]);
  const restore = dir => main(["restore", "--backup-dir", dir, "--env-file", target.envFile, "--compose-file", target.composeFile,
    "--smoke-base-url", target.smokeBaseUrl, "--confirm-restore"]);
  const legacy = JSON.parse(readFileSync(join(fixture.legacyBackupDir, "manifest.json"), "utf8"));
  assert.equal(legacy.schemaVersion, 1); assert.equal(legacy.source.gitCommit, baseline);
  const dump = readFileSync(join(fixture.legacyBackupDir, "postgres.sql"), "utf8");
  assert.ok(!/CREATE TABLE public\.room_plugin_/.test(dump)); assert.ok(dump.includes("rooms_identity_scope_idx"));
  const before = snapshot(), privatePolicy = policy();
  assert.equal(before.pluginTables, 3); assert.equal(before.packages + before.bindings + before.state, 0); assert.equal(before.scopeIndexPresent, true);
  const failureDir = join(root, `legacy-atomic-failure-${Date.now()}`);
  const proof = {};
  try {
    cpSync(fixture.legacyBackupDir, failureDir, { recursive: true });
    const setDump = async sql => {
      writeFileSync(join(failureDir, "postgres.sql"), sql);
      writeFileSync(join(failureDir, "manifest.json"), JSON.stringify(await createBackupManifest({ backupDir: failureDir, source: legacy.source, smoke: legacy.smoke })), { mode: 0o600 });
    };
    const literalSql = String.raw`SELECT encode(convert_to('\','UTF8'),'hex') AS plain,
encode(convert_to('\\','UTF8'),'hex') AS doubled,
encode(convert_to(E'\\','UTF8'),'hex') AS escaped,
1 AS "quote"" and slash\";`;
    const continuationSql = String.raw`SELECT E'prefix '
'quote\' and slash\\' AS continued;`;
    const commitPayload = String.raw`SET standard_conforming_strings=on; SELECT '\'; COMMIT; --'
SELECT 1/0;`;
    const oracleProgram = `
import {Pool} from "pg";const p=new Pool({connectionString:process.env.POSTGRES_URL,max:1});const c=await p.connect();
try {
 await c.query("SET standard_conforming_strings=on");
 const row=(await c.query(${JSON.stringify(literalSql)})).rows[0];
 const continued=(await c.query(${JSON.stringify(continuationSql)})).rows[0].continued;
 await c.query("CREATE TEMP TABLE vrata_lexer_oracle(value text) ON COMMIT PRESERVE ROWS");
 await c.query("BEGIN");await c.query("INSERT INTO pg_temp.vrata_lexer_oracle VALUES('committed-by-payload')");
 let division=false;try{await c.query(${JSON.stringify(commitPayload)});}catch(error){division=error.code==='22012';}
 const survived=Number((await c.query("SELECT count(*) FROM pg_temp.vrata_lexer_oracle")).rows[0].count)===1;
 process.stdout.write(JSON.stringify({plain:row.plain==='5c',doubled:row.doubled==='5c5c',escaped:row.escaped==='5c',continued:continued===${JSON.stringify("prefix quote' and slash\\")},identifier:Object.keys(row).some(key=>key.includes('quote"')&&key.endsWith(String.fromCharCode(92))),commitReallyExecuted:survived,tailReallyFailed:division}));
} finally {c.release();await p.end();}
`;
    const interpreted = JSON.parse(compose(["exec", "-T", "api", "node", "--input-type=module", "-e", oracleProgram]));
    assert.ok(Object.values(interpreted).every(value => value === true)); proof.postgresLiteralInterpretation = true; proof.commitPayloadReallyCommits = true;
    const fileCopy = String.raw`COPY pg_temp.vrata_copy_file FROM '/dev/null' WHERE "from" = "stdin"; COMMIT;`;
    const unicodeCommit = String.raw`SELECT ée'\'; COMMIT; --'
SELECT 1/0;`;
    const nbspCommit = String.raw`SELECT  e'\'; COMMIT; --'
SELECT 1/0;`;
    const sjisCommit = String.raw`SET client_encoding='SJIS'; SELECT E'ぃ\'; COMMIT; --'
SELECT 1/0;`;
    const newOracles = `
import {Pool} from "pg";const p=new Pool({connectionString:process.env.POSTGRES_URL,max:1});const c=await p.connect();let stage='setup';
try {
 await c.query("CREATE TEMP TABLE vrata_new_oracle(value text) ON COMMIT PRESERVE ROWS");
 await c.query('CREATE TEMP TABLE vrata_copy_file("from" integer,"stdin" integer)');
 await c.query("CREATE DOMAIN pg_temp.ée AS text"); await c.query("CREATE DOMAIN pg_temp. e AS text");
 const result={};const cases=${JSON.stringify({ fileCopy, unicodeCommit, nbspCommit, sjisCommit })};
 for(const [name,sql]of Object.entries(cases)){
  stage=name;
  await c.query("SET client_encoding='UTF8'");await c.query("SET standard_conforming_strings=on");
  await c.query("TRUNCATE pg_temp.vrata_new_oracle");await c.query("BEGIN");await c.query("INSERT INTO pg_temp.vrata_new_oracle VALUES('native-commit-proof')");
  // psql sends the encoding SET before the next statement; a single pg query is parsed upfront.
  let payload=sql;if(name==='sjisCommit'){await c.query("SET client_encoding='SJIS'");payload=sql.replace(/^SET client_encoding='SJIS'; /,'');}
  let failed=false;try{await c.query(payload);}catch(error){if(error.code!=='22012')throw error;failed=true;}
  const kept=Number((await c.query("SELECT count(*) FROM pg_temp.vrata_new_oracle")).rows[0].count)===1;
  result[name]=kept&&(name==='fileCopy'||failed);
 }
 await c.query("SET client_encoding='UTF8'");process.stdout.write(JSON.stringify(result));
} catch(error){process.stdout.write(JSON.stringify({oracleFailed:true,stage,code:error.code??'unknown'}));}
finally {c.release();await p.end();}
`;
    const actual = JSON.parse(compose(["exec", "-T", "api", "node", "--input-type=module", "-e", newOracles]));
    assert.deepEqual(actual, { fileCopy: true, unicodeCommit: true, nbspCommit: true, sjisCommit: true });
    Object.assign(proof, { fileCopyWhereReallyCommits: true, utf8IdentifierReallyCommits: true, nbspIdentifierReallyCommits: true, sjisBytesReallyCommit: true });
    const nativePsql = input => {
      try { return { ok: true, stdout: execFileSync("docker", ["compose", "--env-file", target.envFile, "-f", target.composeFile,
        "exec", "-T", "postgres", "sh", "-c", 'psql -XAtq -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],
      { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 }) }; }
      catch (error) { return { ok: false, stdout: String(error.stdout ?? ""), division: /division by zero/.test(String(error.stderr ?? "")) }; }
    };
    // Fixed harmless command inside our disposable container, never archive-supplied shell code.
    const shellPayload = String.raw`SET standard_conforming_strings=on; SELECT '\';
\! /bin/true
--'
SELECT 1/0;`;
    const shellOracle = nativePsql(shellPayload.replace("/bin/true", "printf VRATA_PSQL_ORACLE"));
    assert.ok(!shellOracle.ok && shellOracle.division && shellOracle.stdout.includes("VRATA_PSQL_ORACLE")); proof.psqlPayloadReallyExecutes = true;
    const unicodeShell = String.raw`CREATE TEMP TABLE vrata_domain_init(value text);
CREATE DOMAIN pg_temp.ée AS text;
SELECT ée'\'
\! printf VRATA_UTF8_SHELL_ORACLE
;
`;
    const numericShell = String.raw`SELECT 1e'\'
\! printf VRATA_NUMERIC_SHELL_ORACLE
;
`;
    const unicodeShellResult = nativePsql(unicodeShell), numericShellResult = nativePsql(numericShell);
    assert.ok(unicodeShellResult.stdout.includes("VRATA_UTF8_SHELL_ORACLE"));
    assert.ok(numericShellResult.stdout.includes("VRATA_NUMERIC_SHELL_ORACLE"));
    proof.unicodeAndNumericShellInterpretation = true;
    const copyOracle = nativePsql(String.raw`BEGIN;
CREATE TEMP TABLE vrata_copy_oracle(value text);
COPY pg_temp.vrata_copy_oracle(value) FROM stdin;
\\.
\\! inert
\.
SELECT encode(convert_to(value,'UTF8'),'hex') FROM pg_temp.vrata_copy_oracle ORDER BY value;
ROLLBACK;
`);
    assert.ok(copyOracle.ok); assert.deepEqual(copyOracle.stdout.trim().split(/\r?\n/).sort(), ["5c2120696e657274", "5c2e"]); proof.copyTerminatorsReallyDiffer = true;
    for (const [payload, error] of [[commitPayload, /restore_dump_unsafe_transaction_or_program/], [shellPayload, /restore_dump_unsafe_psql_command/],
      [String.raw`COPY public.t FROM '/dev/null' WHERE "from" = "stdin"; COMMIT;
\.`, /restore_dump_unsupported_copy/],
      [unicodeCommit, /restore_dump_unsafe_transaction_or_program/], [nbspCommit, /restore_dump_unsafe_transaction_or_program/],
      [sjisCommit, /restore_dump_unsupported_encoding/], [String.raw`SELECT ée'\'
\! /bin/true
;`, /restore_dump_unsafe_psql_command/], [numericShell, /restore_dump_unsupported_numeric_boundary/]]) {
      await setDump(dump.replace(/(^CREATE TABLE public\.)/m, `${payload}\n$1`));
      await assert.rejects(restore(failureDir), error);
      const untouched = snapshot();
      assert.ok(untouched.schemaHash === before.schemaHash && untouched.dataHash === before.dataHash);
      assert.ok(policy() === privatePolicy);
    }
    proof.bypassesRejectedBeforeDdl = true;
    // Standalone lexer and actual pg_dump restore both accept ordinary backslashes and E escapes.
    const validFile = join(root, "valid-lexer.sql");
    const validSql = String.raw`SET standard_conforming_strings=on;
SELECT pg_catalog.set_config('search_path','',false);
CREATE TABLE public.rooms(room_id text);
SELECT '\', E'quote\' slash\\', 1 AS "double"" slash\";
/* outer /* COMMIT; */ ROLLBACK; */
CREATE FUNCTION public.fixture() RETURNS text AS $body$ BEGIN RETURN E'quote\' slash\\'; END; $body$ LANGUAGE plpgsql;
COPY public.rooms(room_id) FROM stdin;
\\.
\! inert
\.
`;
    writeFileSync(validFile, validSql, { mode: 0o600 }); assert.deepEqual([...await inspectRestoreDump(validFile)], ["rooms"]);
    const continuationFile = join(root, "unsupported-continuation.sql"); writeFileSync(continuationFile, continuationSql, { mode: 0o600 });
    await assert.rejects(inspectRestoreDump(continuationFile), /restore_dump_unsupported_quote_continuation/);
    proof.unsupportedPsqlContinuationRejected = true;
    proof.standaloneLexerAcceptsValidDump = true;
    const validOracle = nativePsql(String.raw`BEGIN;
SET LOCAL standard_conforming_strings=on;
CREATE TEMP TABLE vrata_note_oracle(value text);
INSERT INTO pg_temp.vrata_note_oracle VALUES ('\'), ('\\'), (E'quote\' slash\\');
/* outer /* COMMIT; */ ROLLBACK; */
CREATE FUNCTION pg_temp.vrata_function_oracle() RETURNS text AS $body$ BEGIN RETURN E'quote\' slash\\'; END; $body$ LANGUAGE plpgsql;
SELECT pg_temp.vrata_function_oracle() = E'quote\' slash\\';
ROLLBACK;
`);
    assert.ok(validOracle.ok && validOracle.stdout.trim() === "t"); proof.postgresAcceptsValidNotesAndFunction = true;
    await setDump(dump.replace(/^SET standard_conforming_strings = on;\r?\n/gm, "") + "\n" + literalSql + "\nSELECT 1/0;\n");
    let sqlError = "";
    const offDefaultRunner = (_compose, args, io) => {
      assert.ok(io.stdinFile && args.at(-1).includes("psql -X --single-transaction"));
      const changed = [...args.slice(0, -1), `PGCLIENTENCODING=SJIS PGOPTIONS='-c client_encoding=SJIS -c standard_conforming_strings=off' ${args.at(-1)}`];
      try { execFileSync("docker", ["compose", "--env-file", target.envFile, "-f", target.composeFile, ...changed],
        { input: readFileSync(io.stdinFile), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 90_000, maxBuffer: 16 * 1024 * 1024 }); }
      catch (error) { sqlError = String(error.stderr ?? ""); throw new Error("fixture_restore_command_failed"); }
    };
    await assert.rejects(main(["restore", "--backup-dir", failureDir, "--env-file", target.envFile, "--compose-file", target.composeFile,
      "--smoke-base-url", target.smokeBaseUrl, "--confirm-restore"], { runCompose: offDefaultRunner }), /fixture_restore_command_failed/);
    writeFileSync(join(root, "off-default-sql-error.log"), sqlError.replace(/https?:\/\/[^\s"<>]+/g, "[url]"), { mode: 0o600 });
    assert.ok(/division by zero/.test(sqlError), "literal SQL must parse correctly even with an off session default");
    assert.ok(snapshot().schemaHash === before.schemaHash && snapshot().dataHash === before.dataHash);
    proof.validLiteralsPreserveRollback = true; proof.driverForcesOnFromOffDefault = true; proof.driverForcesUtf8FromSjisDefault = true;
    const injected = dump.replace(/(^CREATE TABLE public\.)/m, "SELECT 1 / 0;\n$1"); assert.ok(injected !== dump);
    await setDump(injected);
    await assert.rejects(restore(failureDir), /command_failed/);
    const afterFailure = snapshot();
    assert.ok(before.schemaHash === afterFailure.schemaHash, "schema, OIDs and index definitions must roll back exactly");
    assert.ok(before.dataHash === afterFailure.dataHash, "all table data must roll back exactly");
    assert.ok(privatePolicy === policy(), "private policy must remain untouched on SQL failure");
    proof.injectedDdlRollbackExact = true;
    setPolicy("download");
    let raceStarted = false, racedSnapshot;
    try {
      const racePolicy = policy();
      const captureCompose = (_compose, args) => {
        const output = compose(args);
        if (args[0] === "exec" && args[2] === "postgres" && args.at(-1).startsWith("select not (exists(select 1 from public.room_plugin_bindings)")) {
          assert.equal(output.trim(), "t");
          const seeded = JSON.parse(compose(["exec", "-T", "api", "node", "--input-type=module", "-e", raceProgram]));
          assert.deepEqual(seeded, { reserved: true, unsettled: true }); raceStarted = true; racedSnapshot = snapshot();
        }
        return output;
      };
      await assert.rejects(main(["restore", "--backup-dir", fixture.legacyBackupDir, "--env-file", target.envFile, "--compose-file", target.composeFile,
        "--smoke-base-url", target.smokeBaseUrl, "--confirm-restore"], { captureCompose }), /command_failed/);
      assert.ok(raceStarted); assert.equal(racedSnapshot.packages, 1); assert.equal(racedSnapshot.pending, 1);
      const untouched = snapshot(); assert.ok(racedSnapshot.schemaHash === untouched.schemaHash && racedSnapshot.dataHash === untouched.dataHash);
      assert.ok(racePolicy === policy()); proof.raceRecheckPreservesPendingPackageAndPolicy = true;
    } finally {
      if (raceStarted) assert.deepEqual(JSON.parse(compose(["exec", "-T", "api", "node", "--input-type=module", "-e", raceCleanupProgram])), { removed: true });
      setPolicy("none");
    }
    await restore(fixture.legacyBackupDir);
    const after = snapshot(); assert.equal(after.pluginTables, 3); assert.equal(after.packages + after.bindings + after.state, 0);
    const env = Object.fromEntries(readFileSync(target.envFile, "utf8").trim().split("\n").map(line => { const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)]; }));
    const created = await fetch(`${target.smokeBaseUrl}/api/rooms`, { method: "POST", headers: { "content-type": "application/json", "x-vrata-admin-token": env.CONTROL_PLANE_ADMIN_TOKEN },
      body: JSON.stringify({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Created after legacy restore" }) });
    assert.equal(created.status, 201); const room = await created.json();
    const opened = await fetch(`${target.smokeBaseUrl}/rooms/${room.roomId}`); assert.equal(opened.status, 200); await opened.body?.cancel();
    const manifest = await fetch(`${target.smokeBaseUrl}/api/rooms/${room.roomId}/manifest`); assert.equal(manifest.status, 200); await manifest.body?.cancel();
    const seeded = JSON.parse(compose(["exec", "-T", "api", "node", "--input-type=module", "-e", seedProgram]));
    assert.deepEqual(seeded, { ready: true, binding: true, signedExact: true });
    setPolicy("download");
    try {
      const live = snapshot(), livePolicy = policy(); assert.equal(live.packages, 1); assert.equal(live.bindings, 1);
      await assert.rejects(restore(fixture.legacyBackupDir), /legacy_restore_requires_empty_plugin_tables/);
      const untouched = snapshot(); assert.ok(live.schemaHash === untouched.schemaHash && live.dataHash === untouched.dataHash);
      assert.ok(livePolicy === policy(), "nonempty legacy target must be rejected before changing private policy");
      proof.nonemptyLegacyTargetUntouched = true;
    } finally { setPolicy("none"); }
    proof.legacyRestoreAndNewApiPassed = true;
    const noteProbe = JSON.parse(compose(["exec", "-T", "api", "node", "--input-type=module", "-e",
      `import {Pool} from 'pg';const p=new Pool({connectionString:process.env.POSTGRES_URL,max:1});try{const row=(await p.query('select body from public."заметки_lexer" where id=1')).rows[0];process.stdout.write(JSON.stringify({unicodeNotesExact:row.body===${JSON.stringify("Привет 👋 ぃ\\ Unicode notes and backslashes\\")}}));}finally{await p.end();}`]));
    assert.deepEqual(noteProbe, { unicodeNotesExact: true }); proof.realPgDumpUnicodeNotesExact = true;
    writeFileSync(join(root, "sql-parser-proof.json"), JSON.stringify(proof, null, 2), { mode: 0o600 });
  } finally { rmSync(failureDir, { recursive: true, force: true }); }
});
