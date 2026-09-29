import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function docker(args, env = process.env) {
  try {
    return execFileSync("docker", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000, maxBuffer: 20 * 1024 * 1024 }).trim();
  } catch { throw new Error("identity_rollout_probe_failed"); }
}

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
  const exists = table => {
    const result = sql(`select to_regclass('${table}') is not null`);
    if (result !== "t" && result !== "f") throw new Error("identity_rollout_invalid_policy");
    return result === "t";
  };
  let minimum = 1, bound = false;
  if (exists("room_identity_protocol_policy")) {
    const value = sql("select minimum_protocol from room_identity_protocol_policy where singleton=true");
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("identity_rollout_invalid_policy");
    minimum = Number(value);
  }
  if (exists("room_identity_authority_v2")) {
    const value = sql("select exists(select 1 from room_identity_authority_v2)");
    if (value !== "t" && value !== "f") throw new Error("identity_rollout_invalid_policy");
    bound = value === "t";
  }
  if (minimum < 2 && !bound) return;
  if (!/^[a-f0-9]{40}$/.test(imageTag)) throw new Error("identity_rollback_requires_immutable_sha");
  // Shell environment overrides the file only for rendering this candidate.
  let model;
  try { model = JSON.parse(run([...compose, "config", "--format", "json"], { ...process.env, IMAGE_TAG: imageTag })); }
  catch { throw new Error("identity_rollout_invalid_compose_model"); }
  for (const service of ["api", "room-state"]) {
    const image = model.services?.[service]?.image;
    if (typeof image !== "string" || !image.endsWith(`:${imageTag}`)) throw new Error("identity_rollout_image_tag_mismatch");
    run(["pull", image]);
    const label = run(["image", "inspect", "--format", '{{ index .Config.Labels "io.vrata.identity-protocol-floor-guard" }}', image]);
    if (label !== "1") throw new Error(`identity_rollback_below_boundary_forbidden:${service}`);
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
