import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PUBLIC_DEMO_LOCAL_IMAGES,
  assertPublicDemoLocalComposeModel,
  assertPublicDemoLocalEnv,
  checkPublicDemoLocalCompose,
  generatePublicDemoLocalEnv,
  parsePublicDemoLocalEnv,
  parsePublicDemoLocalEnvArgs,
  serializePublicDemoLocalEnv,
  writePublicDemoLocalEnv
} from "./public-demo-local-env.mjs";

const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";
const testFile = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(testFile), "..");
const toolPath = join(repositoryRoot, "tools/public-demo-local-env.mjs");

function deterministicRandomBytes() {
  let value = 0;
  return (size) => {
    const result = Buffer.alloc(size, value);
    value += 1;
    return result;
  };
}

function generatedEnv() {
  return generatePublicDemoLocalEnv({
    sourceSha: SOURCE_SHA,
    randomBytesFn: deterministicRandomBytes()
  });
}

function port(hostIp, published, target, protocol = "tcp") {
  return { host_ip: hostIp, published: String(published), target, protocol };
}

function validComposeModel(env) {
  return {
    services: {
      postgres: {
        image: PUBLIC_DEMO_LOCAL_IMAGES.postgres,
        environment: {
          POSTGRES_DB: env.POSTGRES_DB,
          POSTGRES_USER: env.POSTGRES_USER,
          POSTGRES_PASSWORD: env.POSTGRES_PASSWORD
        }
      },
      livekit: {
        image: PUBLIC_DEMO_LOCAL_IMAGES.livekit,
        command: ["--bind", "0.0.0.0"],
        environment: {
          LIVEKIT_CONFIG: `port: 7880\nrtc:\n  tcp_port: 7881\n  udp_port: 7881\n  node_ip: 127.0.0.1\nkeys:\n  "${env.LIVEKIT_API_KEY}": "${env.LIVEKIT_API_SECRET}"\nturn:\n  enabled: false\n`
        },
        ports: [
          port("127.0.0.1", 7880, 7880),
          port("127.0.0.1", 7881, 7881),
          port("127.0.0.1", 7881, 7881, "udp")
        ]
      },
      "room-state": {
        image: `${env.ROOM_STATE_IMAGE_REPO}:${env.IMAGE_TAG}`,
        environment: {
          NODE_ENV: "production",
          STATE_TOKEN_SECRET: env.STATE_TOKEN_SECRET,
          VRATA_INTERNAL_SERVICE_TOKEN: env.VRATA_INTERNAL_SERVICE_TOKEN,
          VRATA_DEV_ROLE_QUERY: "false",
          REMOTE_BROWSER_ENABLED: "false"
        },
        ports: [port("127.0.0.1", 2567, 2567)]
      },
      minio: {
        image: PUBLIC_DEMO_LOCAL_IMAGES.minio,
        environment: {
          MINIO_ROOT_USER: env.MINIO_ROOT_USER,
          MINIO_ROOT_PASSWORD: env.MINIO_ROOT_PASSWORD
        },
        ports: [port("127.0.0.1", 9000, 9000)]
      },
      "minio-bootstrap": {
        image: PUBLIC_DEMO_LOCAL_IMAGES.minioBootstrap,
        environment: {
          MINIO_ROOT_USER: env.MINIO_ROOT_USER,
          MINIO_ROOT_PASSWORD: env.MINIO_ROOT_PASSWORD,
          MINIO_BUCKET: env.MINIO_BUCKET
        }
      },
      api: {
        image: `${env.API_IMAGE_REPO}:${env.IMAGE_TAG}`,
        depends_on: {
          postgres: { condition: "service_healthy" },
          "room-state": { condition: "service_started" },
          livekit: { condition: "service_started" },
          "minio-bootstrap": { condition: "service_completed_successfully" }
        },
        environment: {
          NODE_ENV: "production",
          LIVEKIT_API_KEY: env.LIVEKIT_API_KEY,
          LIVEKIT_API_SECRET: env.LIVEKIT_API_SECRET,
          STATE_TOKEN_SECRET: env.STATE_TOKEN_SECRET,
          VRATA_INTERNAL_SERVICE_TOKEN: env.VRATA_INTERNAL_SERVICE_TOKEN,
          VRATA_DEV_ROLE_QUERY: "false",
          REMOTE_BROWSER_ENABLED: "false",
          VRATA_ALLOW_INSECURE_PRODUCTION_URLS: "true",
          VRATA_DEPLOY_SHA: env.VRATA_DEPLOY_SHA,
          POSTGRES_URL: env.POSTGRES_URL,
          MINIO_ROOT_USER: env.MINIO_ROOT_USER,
          MINIO_ROOT_PASSWORD: env.MINIO_ROOT_PASSWORD,
          MINIO_BUCKET: env.MINIO_BUCKET
        }
      },
      caddy: {
        image: PUBLIC_DEMO_LOCAL_IMAGES.caddy,
        ports: [port("127.0.0.1", 4000, 80)]
      }
    },
    networks: {
      default: {}
    }
  };
}

function expectedError(code) {
  return (error) => error instanceof Error && error.message === code;
}

test("generator creates valid unique projects, credentials, and an exact source SHA contract", () => {
  const first = generatePublicDemoLocalEnv({ sourceSha: SOURCE_SHA });
  const second = generatePublicDemoLocalEnv({ sourceSha: SOURCE_SHA });

  assert.equal(assertPublicDemoLocalEnv(first), true);
  assert.equal(first.IMAGE_TAG, SOURCE_SHA);
  assert.equal(first.VRATA_DEPLOY_SHA, SOURCE_SHA);
  assert.notEqual(first.COMPOSE_PROJECT_NAME, second.COMPOSE_PROJECT_NAME);
  assert.notEqual(first.LIVEKIT_API_KEY, second.LIVEKIT_API_KEY);
  assert.notEqual(first.LIVEKIT_API_SECRET, second.LIVEKIT_API_SECRET);
  assert.equal(Object.hasOwn(first, "VRATA_ALLOW_INSECURE_PRODUCTION_URLS"), false);
});

test("env serialization and parsing round-trip without accepting duplicate keys", () => {
  const env = generatedEnv();
  assert.deepEqual(parsePublicDemoLocalEnv(serializePublicDemoLocalEnv(env)), env);
  assert.throws(
    () => parsePublicDemoLocalEnv("IMAGE_TAG=one\nIMAGE_TAG=two\n"),
    expectedError("public_demo_local_env_duplicate:IMAGE_TAG")
  );
  assert.deepEqual(parsePublicDemoLocalEnvArgs(["--output", "demo.env", "--source-sha", SOURCE_SHA]), {
    outputPath: "demo.env",
    sourceSha: SOURCE_SHA,
    help: false,
    check: false
  });
});

test("env assertion rejects noncanonical SHAs, dev credentials, and credential drift", () => {
  const uppercaseSha = { ...generatedEnv(), IMAGE_TAG: SOURCE_SHA.toUpperCase(), VRATA_DEPLOY_SHA: SOURCE_SHA.toUpperCase() };
  assert.throws(() => assertPublicDemoLocalEnv(uppercaseSha), expectedError("public_demo_local_image_tag_invalid"));

  const mismatchedSha = { ...generatedEnv(), VRATA_DEPLOY_SHA: "f".repeat(40) };
  assert.throws(() => assertPublicDemoLocalEnv(mismatchedSha), expectedError("public_demo_local_deploy_sha_mismatch"));

  const devCredentials = { ...generatedEnv(), LIVEKIT_API_KEY: "devkey" };
  assert.throws(() => assertPublicDemoLocalEnv(devCredentials), expectedError("public_demo_local_dev_credential_forbidden"));

  const reusedSecret = generatedEnv();
  reusedSecret.STATE_TOKEN_SECRET = reusedSecret.LIVEKIT_API_SECRET;
  assert.throws(() => assertPublicDemoLocalEnv(reusedSecret), expectedError("public_demo_local_credentials_not_unique"));
});

test("writer creates a secret-safe exclusive mode-0600 env file for the exact clean checkout", () => {
  const directory = mkdtempSync(join(tmpdir(), "vrata-demo-local-env-"));
  const outputPath = join(directory, "demo.env");
  try {
    const first = writePublicDemoLocalEnv({
      outputPath,
      sourceSha: SOURCE_SHA,
      cwd: repositoryRoot,
      inspectCheckout: () => ({ sourceSha: SOURCE_SHA, clean: true })
    });
    assert.equal(first.outputPath, outputPath);
    assert.equal(statSync(outputPath).mode & 0o777, 0o600);

    const env = parsePublicDemoLocalEnv(readFileSync(outputPath, "utf8"));
    assert.equal(assertPublicDemoLocalEnv(env), true);
    assert.throws(() => writePublicDemoLocalEnv({
      outputPath,
      sourceSha: SOURCE_SHA,
      cwd: repositoryRoot,
      inspectCheckout: () => ({ sourceSha: SOURCE_SHA, clean: true })
    }), (error) => error.code === "EEXIST");
    assert.equal(readFileSync(outputPath, "utf8"), serializePublicDemoLocalEnv(env));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI rejects dirty and mismatched source checkouts without writing secrets", () => {
  const directory = mkdtempSync(join(tmpdir(), "vrata-demo-local-checkout-"));
  const outputPath = join(directory, "demo.env");
  try {
    writeFileSync(join(directory, ".gitignore"), "demo.env\n", "utf8");
    writeFileSync(join(directory, "README.md"), "fixture\n", "utf8");
    for (const args of [
      ["init", "--quiet"],
      ["add", "."],
      ["-c", "user.name=VRATA Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture"]
    ]) {
      const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).stdout.trim();
    const mismatch = spawnSync(process.execPath, [toolPath, "--output", outputPath, "--source-sha", SOURCE_SHA], { cwd: directory, encoding: "utf8" });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /public_demo_local_source_sha_mismatch/);

    writeFileSync(join(directory, "README.md"), "dirty\n", "utf8");
    const dirty = spawnSync(process.execPath, [toolPath, "--output", outputPath, "--source-sha", head], { cwd: directory, encoding: "utf8" });
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /public_demo_local_checkout_dirty/);
    assert.equal(readFileSync(join(directory, "README.md"), "utf8"), "dirty\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("compose model assertion accepts only the isolated production-mode model", () => {
  const env = generatedEnv();
  assert.equal(assertPublicDemoLocalComposeModel(validComposeModel(env), env), true);

  const publicBind = validComposeModel(env);
  publicBind.services.caddy.ports[0].host_ip = "0.0.0.0";
  assert.throws(
    () => assertPublicDemoLocalComposeModel(publicBind, env),
    expectedError("public_demo_local_non_loopback_port:caddy")
  );

  const floatingImage = validComposeModel(env);
  floatingImage.services.api.image = "vrata-demo-api:latest";
  assert.throws(
    () => assertPublicDemoLocalComposeModel(floatingImage, env),
    expectedError("public_demo_local_floating_image:api")
  );

  const remoteBrowser = validComposeModel(env);
  remoteBrowser.services["remote-browser"] = { image: `${env.REMOTE_BROWSER_IMAGE_REPO}:${env.IMAGE_TAG}` };
  assert.throws(
    () => assertPublicDemoLocalComposeModel(remoteBrowser, env),
    expectedError("public_demo_local_remote_browser_present")
  );

  const devCredential = validComposeModel(env);
  devCredential.services.api.environment.STATE_TOKEN_SECRET = "dev-state-secret";
  assert.throws(
    () => assertPublicDemoLocalComposeModel(devCredential, env),
    expectedError("public_demo_local_dev_credential:api:STATE_TOKEN_SECRET")
  );

  const mismatchedLivekit = validComposeModel(env);
  mismatchedLivekit.services.api.environment.LIVEKIT_API_SECRET = `other_${"f".repeat(64)}`;
  assert.throws(
    () => assertPublicDemoLocalComposeModel(mismatchedLivekit, env),
    expectedError("public_demo_local_livekit_credentials_mismatch")
  );
});

const composeVersion = spawnSync("docker", ["compose", "version", "--short"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  timeout: 10_000
});
const composeAvailable = composeVersion.status === 0;

test("docker compose renders the selfhost overlay into the validated local-only model", { skip: !composeAvailable }, () => {
  const version = composeVersion.stdout.trim().replace(/^v/, "");
  const [major, minor, patch] = version.split(".").map((part) => Number.parseInt(part, 10));
  assert.equal(
    major > 2 || (major === 2 && (minor > 24 || (minor === 24 && patch >= 4))),
    true,
    `Docker Compose ${version} does not support !override/!reset`
  );

  const directory = mkdtempSync(join(tmpdir(), "vrata-demo-local-compose-"));
  const envPath = join(directory, "demo.env");
  try {
    writePublicDemoLocalEnv({
      outputPath: envPath,
      sourceSha: SOURCE_SHA,
      cwd: repositoryRoot,
      inspectCheckout: () => ({ sourceSha: SOURCE_SHA, clean: true })
    });
    const env = parsePublicDemoLocalEnv(readFileSync(envPath, "utf8"));

    const rendered = spawnSync("docker", [
      "compose",
      "--env-file", envPath,
      "-f", "infra/docker/compose.selfhost.yml",
      "-f", "infra/docker/compose.demo-local.yml",
      "config",
      "--format", "json"
    ], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 30_000
    });
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.equal(assertPublicDemoLocalComposeModel(JSON.parse(rendered.stdout), env), true);
    assert.deepEqual(checkPublicDemoLocalCompose(envPath, repositoryRoot), { project: env.COMPOSE_PROJECT_NAME, imageSha: SOURCE_SHA });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
