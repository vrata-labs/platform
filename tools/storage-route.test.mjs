import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const read = name => readFileSync(new URL(`../infra/docker/${name}`, import.meta.url), "utf8");

function storageBlock(caddyfile) {
  const start = caddyfile.indexOf("{$VRATA_STORAGE_DOMAIN} {");
  assert.ok(start >= 0, "storage site block");
  return caddyfile.slice(start, caddyfile.indexOf("\n}\n", start) + 3);
}

function caddyImage(file = "compose.staging.yml") {
  const match = read(file).match(/\n  caddy:\n(?:    .*\n)*?    image: (\S+)\n/);
  assert.ok(match, `${file} caddy image`);
  return match[1];
}

const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

// Raw request: node:http keeps the path as given, unlike fetch/URL, which would resolve dot segments.
function get(port, path, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method }, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("every compose storage service pins the hash of its mounted start script", () => {
  const hash = createHash("sha256").update(readFileSync(new URL("../infra/docker/storage-server.sh", import.meta.url))).digest("hex");
  for (const file of ["compose.staging.yml", "compose.selfhost.yml", "compose.production.yml"]) {
    // A changed script alone would not recreate a running container; the hash makes the change a config change.
    assert.ok(read(file).includes(`      VRATA_STORAGE_SERVER_SHA256: ${hash}\n`), file);
  }
});

test("staging and production publish the same storage route on the same pinned Caddy", () => {
  assert.equal(storageBlock(read("Caddyfile.production")), storageBlock(read("Caddyfile.staging")));
  assert.match(caddyImage(), /@sha256:[0-9a-f]{64}$/);
  assert.equal(caddyImage("compose.production.yml"), caddyImage());
});

test("storage route proxies only public object reads and refuses the rest before the storage", { skip: !dockerAvailable, timeout: 180_000 }, async t => {
  const suffix = randomBytes(4).toString("hex");
  const network = `vrata-storage-route-${suffix}`;
  const dir = mkdtempSync(join(tmpdir(), "vrata-storage-route-"));
  const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  t.after(() => {
    spawnSync("docker", ["rm", "-f", `${network}-front`, `${network}-storage`], { stdio: "ignore" });
    spawnSync("docker", ["network", "rm", network], { stdio: "ignore" });
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, "storage"), ":9000 {\n  respond \"UPSTREAM {uri}\" 200\n}\n");
  writeFileSync(join(dir, "front"), `{\n  auto_https off\n  admin off\n}\n${storageBlock(read("Caddyfile.staging"))}`);
  const image = caddyImage();
  docker("network", "create", network);
  docker("run", "-d", "--name", `${network}-storage`, "--network", network, "--network-alias", "minio",
    "-v", `${join(dir, "storage")}:/etc/caddy/Caddyfile:ro`, image);
  docker("run", "-d", "--name", `${network}-front`, "--network", network, "-p", "127.0.0.1::80",
    "-e", "VRATA_STORAGE_DOMAIN=:80", "-e", "MINIO_BUCKET=public-assets", "-v", `${join(dir, "front")}:/etc/caddy/Caddyfile:ro`, image);
  const port = Number(docker("port", `${network}-front`, "80/tcp").split("\n")[0].split(":").at(-1));
  for (let attempt = 0; ; attempt++) {
    try { if ((await get(port, "/public-assets/ready")).status === 200) break; } catch { /* still starting */ }
    assert.ok(attempt < 50, "front proxy did not start");
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  for (const [path, method] of [
    ["/public-assets/scenes/hall/scene.json"], ["/public-assets/a%20b/c%2Bd.json"], ["/public-assets/%D0%B4%D0%BE%D0%BA.pdf"],
    ["/public-assets/a..b.json"], ["/public-assets/scenes/hall/scene.glb", "HEAD"], ["/public-assets/scenes/hall/scene.glb", "OPTIONS"],
    ["/public-assets/documents-other/key"], ["/public-assets/scenes/documents/x.json"]
  ]) {
    const response = await get(port, path, method);
    assert.equal(response.status, 200, `${method ?? "GET"} ${path}`);
    if (method !== "HEAD") assert.equal(response.body, `UPSTREAM ${path}`, path);
  }
  for (const [path, method] of [
    ["/"], ["/public-assets"], ["/public-assets/"], ["/public-assets/?list-type=2"], ["/public-assets/key?acl"], ["/public-assets/key?x=1"],
    ["/room-plugins/x/code.js"], ["/public-assets-other/key"], ["/PUBLIC-ASSETS/key"],
    ["/public-assets/../room-plugins/x"], ["/public-assets/%2e%2e/room-plugins/x"], ["/public-assets/x%2f..%2f..%2froom-plugins/y"],
    ["/public-assets/x/../key"], ["/public-assets/x/%2E%2E/key"], ["/public-assets/./key"], ["/public-assets//key"], ["/public-assets/x/.."],
    ["/public-assets/x%5ckey"], ["/public-assets/x%00key"],
    ["/public-assets/documents/demo-tenant/room/doc/agenda.pdf"], ["/public-assets/documents/demo-tenant/room/doc/agenda.pdf", "HEAD"],
    ["/public-assets/%64ocuments/demo-tenant/room/doc/agenda.pdf"], ["/public-assets/documents/x", "OPTIONS"],
    ["/public-assets/key", "PUT"], ["/public-assets/key", "POST"], ["/public-assets/key", "DELETE"], ["/public-assets/key", "PATCH"]
  ]) {
    const response = await get(port, path, method);
    assert.equal(response.status, 403, `${method ?? "GET"} ${path}`);
    assert.doesNotMatch(response.body, /UPSTREAM/, `${method ?? "GET"} ${path} reached the storage`);
  }
});
