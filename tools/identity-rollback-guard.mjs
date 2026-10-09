import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function docker(args, env = process.env) {
  try {
    return execFileSync("docker", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000, maxBuffer: 20 * 1024 * 1024 }).trim();
  } catch { throw new Error("identity_rollout_probe_failed"); }
}

// Match the reader's bound version and reference markers. Probes return scalar booleans only.
export const ROOM_RECORD_SCHEMA_SQL = "select count(*) = 9 from pg_attribute where not attisdropped and attnum > 0 and ("
  + "(attrelid = to_regclass('rooms') and attname in ('template_id', 'template_version', 'room_type', 'owner_participant_id'))"
  + " or (attrelid = to_regclass('templates') and attname in ('template_id', 'current_version'))"
  + " or (attrelid = to_regclass('template_versions') and (attname in ('template_id', 'version') or (attname = 'snapshot' and atttypid = 'jsonb'::regtype))))";
export const OWNERLESS_REFERENCE_PERSONAL_SQL = "select exists(select 1 from rooms r"
  + " left join templates t on t.template_id = r.template_id"
  + " left join template_versions tv on tv.template_id = r.template_id and tv.version = coalesce(r.template_version, t.current_version)"
  + " cross join lateral (select case when jsonb_typeof(tv.snapshot) = 'string' then (tv.snapshot #>> '{}')::jsonb else tv.snapshot end as snapshot) s"
  + " where r.room_type = 'personal' and r.owner_participant_id is null"
  + " and (s.snapshot is null or jsonb_typeof(s.snapshot) <> 'object' or s.snapshot ?| array['defaults', 'scene', 'assetLock']))";

/** Runs before a production/self-host rollback edits its env file or services. */
export function assertIdentityRollbackTarget({ envFile, composeFile, imageTag }, run = docker) {
  if (typeof imageTag !== "string" || imageTag === "latest" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(imageTag)) throw new Error("invalid_image_tag");
  const compose = ["compose", "--env-file", envFile, "-f", composeFile];
  let current;
  try { current = JSON.parse(run([...compose, "config", "--format", "json"])); }
  catch { throw new Error("identity_rollout_invalid_compose_model"); }
  const api = current.services?.api?.environment ?? {}, postgres = current.services?.postgres?.environment ?? {};
  let matches = false;
  try {
    const url = new URL(api.POSTGRES_URL);
    matches = ["postgres:", "postgresql:"].includes(url.protocol) && url.hostname === "postgres" && (!url.port || url.port === "5432")
      && !url.search && !api.PGOPTIONS && decodeURIComponent(url.username) === postgres.POSTGRES_USER
      && decodeURIComponent(url.pathname.slice(1)) === postgres.POSTGRES_DB
      && !["PGHOST", "PGHOSTADDR", "PGPORT", "PGOPTIONS", "PGSERVICE", "PGSERVICEFILE"].some(key => postgres[key]);
  } catch { /* Credentials and arbitrary URL values must not reach the error. */ }
  if (!matches) throw new Error("identity_rollout_requires_matching_bundled_database");
  const sql = text => run([...compose, "exec", "-T", "postgres", "sh", "-c",
    'psql -XAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"', "sh", text]);
  const exists = (table, code = "identity_rollout_invalid_policy") => {
    const result = sql(`select to_regclass('${table}') is not null`);
    if (result !== "t" && result !== "f") throw new Error(code);
    return result === "t";
  };
  let minimum = 1, bound = false;
  const policy = exists("room_identity_protocol_policy");
  if (policy) {
    const value = sql("select minimum_protocol from room_identity_protocol_policy where singleton=true");
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("identity_rollout_invalid_policy");
    minimum = Number(value);
  }
  const authority = exists("room_identity_authority_v2");
  if (authority) {
    const value = sql("select exists(select 1 from room_identity_authority_v2)");
    if (value !== "t" && value !== "f") throw new Error("identity_rollout_invalid_policy");
    bound = value === "t";
  }
  let ownerless = false;
  if (exists("rooms", "room_record_rollout_invalid_reference_state")) {
    if (sql(ROOM_RECORD_SCHEMA_SQL) !== "t") throw new Error("room_record_rollout_invalid_reference_state");
    const value = sql(OWNERLESS_REFERENCE_PERSONAL_SQL);
    if (value !== "t" && value !== "f") throw new Error("room_record_rollout_invalid_reference_state");
    ownerless = value === "t";
  } else if (policy || authority) throw new Error("room_record_rollout_invalid_reference_state");
  const boundary = minimum >= 2 || bound;
  // At floor two the running API may create ownerless records after this probe.
  const reader = minimum >= 2 || ownerless;
  if (!boundary && !reader) return;
  if (!/^[a-f0-9]{40}$/.test(imageTag)) throw new Error("identity_rollback_requires_immutable_sha");
  // Shell environment overrides the file only for rendering this candidate.
  let model;
  try { model = JSON.parse(run([...compose, "config", "--format", "json"], { ...process.env, IMAGE_TAG: imageTag })); }
  catch { throw new Error("identity_rollout_invalid_compose_model"); }
  for (const service of boundary ? ["api", "room-state"] : ["api"]) {
    const image = model.services?.[service]?.image;
    if (typeof image !== "string" || !image.endsWith(`:${imageTag}`)) throw new Error("identity_rollout_image_tag_mismatch");
    run(["pull", image]);
    if (boundary) {
      const label = run(["image", "inspect", "--format", '{{ index .Config.Labels "io.vrata.identity-protocol-floor-guard" }}', image]);
      if (label !== "1") throw new Error(`identity_rollback_below_boundary_forbidden:${service}`);
    }
    if (service === "api" && reader) {
      const value = run(["image", "inspect", "--format", '{{ index .Config.Labels "io.vrata.room-record-reader" }}', image]);
      if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 2) throw new Error("room_record_rollback_requires_reader2:api");
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = process.argv[index], value = process.argv[index + 1];
      if (!["--env-file", "--compose-file", "--image-tag"].includes(key) || !value || Object.hasOwn(options, key)) throw new Error("identity_rollout_invalid_arguments");
      options[key] = value;
    }
    if (!options["--env-file"] || !options["--compose-file"] || !options["--image-tag"]) throw new Error("identity_rollout_missing_arguments");
    assertIdentityRollbackTarget({ envFile: options["--env-file"], composeFile: options["--compose-file"], imageTag: options["--image-tag"] });
    process.stdout.write("identity_rollout_preflight_passed\n");
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
