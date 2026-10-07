import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { expect, type APIRequestContext, type Page } from "playwright/test";
import type { AuthorHttpResponse, startAuthorHttpFixture } from "../../apps/api/src/plugins/author-http.test-helper.js";

export const publicSdkSha256 = "c301002fb1fdbd3eb1c4aad396adef4e0160d450051f1a3ee5e9ae84b66a7896";
export const nativeMarker = "__T05_NATIVE_AUTHOR_EXECUTED__";
export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
export const pluginPath = (roomId: string, suffix: string) => `/api/rooms/${encodeURIComponent(roomId)}/plugins/${suffix}`;

export function inviteTokenFromLink(link: string): string {
  try {
    const token = new URL(link).searchParams.get("invite");
    if (token) return token;
  } catch { /* Do not put a malformed private invitation URL in an exception. */ }
  throw new Error("plugin_author_invitation_link_invalid");
}

// Native fetch avoids retaining private request bodies/credentials in Playwright API call logs.
// Assertions and failures deliberately expose only statuses, revisions, hashes and fixed codes.
export async function privateHttp(origin: string, path: string, method = "GET", headers: Record<string, string> = {}, body?: unknown): Promise<AuthorHttpResponse> {
  try {
    const binary = body instanceof Uint8Array;
    const response = await fetch(new URL(path, origin), {
      method, redirect: "error", headers: { ...(body === undefined ? {} : { "content-type": binary ? "application/octet-stream" : "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: binary ? new Uint8Array(body) : JSON.stringify(body) }), signal: AbortSignal.timeout(15_000)
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: Object.fromEntries(response.headers), bytes, json: <T>() => {
      try { return JSON.parse(bytes.toString("utf8")) as T; }
      catch { throw new Error("plugin_author_invalid_json_response"); }
    } };
  } catch { throw new Error("plugin_author_http_transport_failed"); }
}

export function assertDenied(response: AuthorHttpResponse, status: number, code: string): void {
  expect(response.status).toBe(status);
  expect(response.bytes.toString("utf8") === JSON.stringify({ error: code })).toBe(true);
  for (const header of ["content-disposition", "x-artifact-sha256", "etag"]) expect(response.headers[header] === undefined).toBe(true);
}

export function assertPublicDto(value: unknown, privateValues: string[] = []): void {
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      expect(/storage.?key|backend.?fingerprint|credential|secret|password|access.?key|tenantId|roomId|^entry$/i.test(key)).toBe(false);
      walk(child);
    }
  };
  walk(value);
  const text = JSON.stringify(value);
  expect(["rs2.", "ri2.", "room-plugins/", nativeMarker, ...privateValues].some(item => item.length > 0 && text.includes(item))).toBe(false);
}

export async function startIsolatedAuthorApi(floor: 1 | 2 = 2) {
  if (!process.env.VRATA_TEST_POSTGRES_URL) throw new Error("plugin_author_requires_isolated_postgres_including_ci");
  const cleanups: Array<() => unknown> = [];
  // The compiled Node helper uses only t.after(). Register it explicitly rather than
  // pretending Playwright TestInfo is a Node TestContext; run cleanup even on failed setup.
  const adapter = { after(callback: () => unknown) { cleanups.push(callback); } };
  const close = async () => {
    let failed = false;
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { await cleanup(); } catch { failed = true; }
    }
    if (failed) throw new Error("plugin_author_owned_fixture_cleanup_failed");
  };
  try {
    const helper: { startAuthorHttpFixture: typeof startAuthorHttpFixture } = await import(pathToFileURL(resolve("apps/api/dist/plugins/author-http.test-helper.js")).href);
    // Helper guards the policy relation's namespace before raising ONLY its own
    // fresh schema and checks the unchanged public floor during cleanup.
    const fixture = await helper.startAuthorHttpFixture(adapter as TestContext, floor);
    return { ...fixture, close };
  } catch {
    await close();
    throw new Error("plugin_author_owned_fixture_setup_failed");
  }
}

export async function runFloorOneAuthorDenial(origin: string, admin: Record<string, string>, page: Page): Promise<void> {
  const tenantId = `plugin-author-denial-${randomUUID()}`;
  let tenantCreated = false, roomId: string | undefined;
  const inviteIds: string[] = [];
  try {
    expect((await privateHttp(origin, "/api/tenants", "POST", admin, { tenantId, name: "Plugin author floor-one denial" })).status).toBe(201);
    tenantCreated = true;
    const created = await privateHttp(origin, "/api/rooms", "POST", admin, {
      tenantId, templateId: "meeting-room-basic", name: "Private plugin denial fixture", visibility: "private", guestAllowed: true,
      features: { voice: false, screenShare: false, spatialAudio: false }
    });
    expect(created.status).toBe(201);
    roomId = created.json<{ roomId: string }>().roomId;
    const invitation = await privateHttp(origin, `/api/rooms/${roomId}/invites`, "POST", admin,
      { role: "host", waitingRoomEnabled: false, expiresInSeconds: 600 });
    expect(invitation.status).toBe(201);
    const invite = invitation.json<{ inviteId: string; inviteLink: string }>();
    inviteIds.push(invite.inviteId);
    const inviteToken = inviteTokenFromLink(invite.inviteLink);
    const participantId = `plugin-denial-${randomUUID()}`;
    const admitted = await privateHttp(origin, "/api/tokens/state", "POST", {},
      { roomId, participantId, displayName: "Legacy plugin Host", inviteToken });
    expect(admitted.status).toBe(200);
    const host = admitted.json<{ token: string; role: string }>();
    expect(host.role === "host").toBe(true);
    // Legacy is base64url(JSON).base64url(HMAC-SHA256), not a three-part JWT.
    // Check the exact two-part family and 43-character MAC without echoing it.
    expect(typeof host.token === "string" && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(host.token)).toBe(true);
    let claims: { role: string; roleSource: string; roomId: string; tenantId: string; participantId: string };
    try { claims = JSON.parse(Buffer.from(host.token.split(".")[0], "base64url").toString("utf8")); }
    catch { throw new Error("plugin_author_floor_one_legacy_claims_invalid"); }
    expect(claims.role === "host" && claims.roleSource === "trusted" && claims.roomId === roomId &&
      claims.tenantId === tenantId && claims.participantId === participantId).toBe(true);
    // Format/decoded claims do not prove authority: the server verifies this
    // Bearer's MAC and scope and resolves the active Host before plugin denial.
    const control = await privateHttp(origin, `/api/rooms/${roomId}/session-control`, "GET", bearer(host.token));
    expect(control.status).toBe(200);
    const state = control.json<{ participant: { participantId: string; role: string; status: string }; state: { hostParticipantId: string } }>();
    expect(state.participant.participantId === participantId && state.participant.role === "host" && state.participant.status === "active").toBe(true);
    expect(state.state.hostParticipantId === participantId).toBe(true);

    // Together, real v1 admission and plugin-family refusal prove floor=1.
    // Never read the internal service secret or mutate the shared policy.
    const packageId = randomUUID(), pluginId = "external.stage-denial";
    const entry = `globalThis.${nativeMarker} = true; export function init() {}`;
    const artifact = Buffer.from(JSON.stringify({ manifest: { schemaVersion: 1, sdkApiVersion: 1, id: pluginId,
      version: "1.0.0", displayName: "Denial fixture", requestedCapabilities: ["status.set"],
      configSchema: { greeting: { type: "string", required: true, minLength: 1, maxLength: 256 } },
      entrySha256: createHash("sha256").update(entry, "utf8").digest("hex") }, entry }));
    const binding = { expectedRevision: 0, packageId, version: "1.0.0", artifactSha256: sha256(artifact), enabled: true,
      config: { greeting: "PRIVATE_STAGING_DENIAL_CONFIG" }, approvedCapabilities: ["status.set"] };
    const routes = [["packages", "GET", undefined], ["packages", "POST", artifact], ["runtime", "GET", undefined],
      [`packages/${packageId}/content`, "GET", undefined], [`packages/${packageId}`, "DELETE", undefined],
      [`bindings/${pluginId}`, "PUT", binding], [`bindings/${pluginId}`, "DELETE", { expectedRevision: 0 }]] as const;
    for (const headers of [bearer(host.token), admin, {}, { cookie: `sessionToken=${host.token}` }, bearer(inviteToken)]) {
      for (const [suffix, method, body] of routes) {
        assertDenied(await privateHttp(origin, pluginPath(roomId, suffix), method, headers, body), 409, "plugin_identity_not_active");
      }
    }
    const navigation = await page.goto(`${origin}/rooms/${roomId}`, { waitUntil: "domcontentloaded" }).catch(() => {
      throw new Error("plugin_author_floor_one_room_shell_navigation_failed");
    });
    expect(navigation?.status()).toBe(200);
    // Browser byte transport also returns only the stable denial; no source eval.
    const sourceDenial = await page.evaluate(async ({ path, token, marker }) => {
      const response = await fetch(path, { credentials: "omit", headers: { authorization: `Bearer ${token}` } });
      const body = await response.json();
      return { status: response.status, denied: JSON.stringify(body) === JSON.stringify({ error: "plugin_identity_not_active" }),
        attachment: response.headers.has("content-disposition"), checksum: response.headers.has("x-artifact-sha256"),
        nativeExecuted: Reflect.has(globalThis, marker) };
    }, { path: pluginPath(roomId, `packages/${packageId}/content`), token: host.token, marker: nativeMarker }).catch(() => {
      throw new Error("plugin_author_floor_one_browser_denial_failed");
    });
    expect(sourceDenial.status).toBe(409); expect(sourceDenial.denied).toBe(true);
    expect(sourceDenial.attachment || sourceDenial.checksum || sourceDenial.nativeExecuted).toBe(false);
    expect((await privateHttp(origin, `/api/rooms/${roomId}/session-control`, "GET", bearer(host.token))).status).toBe(200);
    // Deleting only the owned room exercises indexed cleanup; an HTTP denial
    // alone is not evidence of DB/quota state or positive T01a author activation.
  } finally {
    await page.goto("about:blank").catch(() => undefined);
    let failed = false;
    for (const inviteId of inviteIds) {
      try { expect((await privateHttp(origin, `/api/rooms/${roomId}/invites/${inviteId}/revoke`, "POST", admin)).status).toBe(200); }
      catch { failed = true; }
    }
    if (roomId) {
      try { expect((await privateHttp(origin, `/api/rooms/${roomId}`, "DELETE", admin)).status).toBe(200); }
      catch { failed = true; }
    }
    if (tenantCreated) {
      try { expect((await privateHttp(origin, `/api/tenants/${tenantId}`, "DELETE", admin)).status).toBe(200); }
      catch { failed = true; }
    }
    if (failed) throw new Error("plugin_author_floor_one_owned_resources_cleanup_failed");
  }
}

export async function downloadPublicSdk(request: APIRequestContext): Promise<Buffer> {
  const manifestResponse = await request.get("/assets/plugin-sdk/releases.json", { maxRedirects: 0 });
  expect(manifestResponse.status()).toBe(200);
  const manifest = await manifestResponse.json();
  expect(manifest.schemaVersion).toBe(1);
  const release = manifest.releases.find((row: { sha256: string }) => row.sha256 === publicSdkSha256);
  expect(Boolean(release)).toBe(true);
  expect(release.package === "@vrata/room-plugin-sdk" && release.version === "0.1.0").toBe(true);
  const url = `/assets/plugin-sdk/0.1.0/${publicSdkSha256}/vrata-room-plugin-sdk-0.1.0.tgz`;
  expect(release.url === url).toBe(true);
  const response = await request.get(url, { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  expect(response.headers()["x-content-type-options"] === "nosniff").toBe(true);
  const bytes = await response.body();
  expect(bytes.byteLength > 0 && bytes.byteLength <= 1024 * 1024).toBe(true);
  expect(sha256(bytes)).toBe(publicSdkSha256);
  return bytes;
}

type CliSummary = { ok: boolean; command: string; artifactSha256?: string; entrySha256: string; bytes: number };
export type ExternalArtifact = { bytes: Buffer; artifactSha256: string; entrySha256: string; pluginId: string; version: string; capabilities: string[] };

export async function createExternalAuthorProject(sdk: Buffer) {
  const root = await mkdtemp(join(tmpdir(), "vrata-plugin-author-external-"));
  const close = () => rm(root, { recursive: true, force: true });
  const markerPath = join(root, "native-execution-marker");
  try {
    const outside = relative(await realpath(process.cwd()), await realpath(root));
    expect(outside.startsWith("..") || outside.startsWith("/")).toBe(true);
    await writeFile(join(root, "sdk.tgz"), sdk);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "external-room-author", private: true, type: "module",
      dependencies: { "@vrata/room-plugin-sdk": "file:./sdk.tgz" } }));

    async function run(command: string, args: string[], json: boolean): Promise<CliSummary | undefined> {
      // No inherited platform secrets, install scripts, private registry or monorepo resolution.
      const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, npm_config_cache: join(root, ".npm-cache"),
        npm_config_ignore_scripts: "true", npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" };
      return new Promise((resolveResult, reject) => {
        const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", settled = false;
        const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
        child.stderr.resume();
        child.stdout.on("data", data => { if (json) stdout = (stdout + String(data)).slice(0, 4096); });
        const fail = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error("plugin_author_external_tool_failed")); } };
        child.once("error", fail);
        child.once("exit", code => {
          if (code !== 0) { fail(); return; }
          if (settled) return;
          settled = true; clearTimeout(timer);
          if (!json) { resolveResult(undefined); return; }
          try { resolveResult(JSON.parse(stdout) as CliSummary); }
          catch { reject(new Error("plugin_author_cli_summary_invalid")); }
        });
      });
    }

    await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/"], false);
    const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
    expect(Object.entries(lock.packages).every(([name, row]) => {
      const pkg = row as { resolved?: string; link?: boolean };
      return name === "" || !pkg.link && (pkg.resolved === "file:sdk.tgz" || pkg.resolved?.startsWith("https://registry.npmjs.org/") === true);
    })).toBe(true);
    const installed = JSON.parse(await readFile(join(root, "node_modules/@vrata/room-plugin-sdk/package.json"), "utf8"));
    expect(installed.name === "@vrata/room-plugin-sdk" && installed.version === "0.1.0").toBe(true);
    expect(JSON.stringify(installed.dependencies) === JSON.stringify({ acorn: "8.18.0", esbuild: "0.25.12" })).toBe(true);
    const cli = join(root, "node_modules/.bin/vrata-room-plugin");

    async function build(pluginId: string, version = "1.0.0", capabilities = ["status.set"]): Promise<ExternalArtifact> {
      // A native API evaluation would write an owned marker; a browser evaluation
      // would set the global marker. Building/parsing/downloading must do neither.
      const source = `import type { RoomPluginContext, RoomPluginEvent } from "@vrata/room-plugin-sdk";
globalThis.${nativeMarker} = true;
if (typeof process !== "undefined") process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "executed");
export function init(context: RoomPluginContext) { return context.sdk.status.set("Author example initialized"); }
export function onEvent(event: RoomPluginEvent, context: RoomPluginContext) {
  if (event.type === "room.ready") return context.sdk.status.set(String(context.config.greeting));
}
export function dispose() {}
`;
      await writeFile(join(root, "entry.ts"), source);
      await writeFile(join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, sdkApiVersion: 1, id: pluginId, version,
        displayName: "External author example", requestedCapabilities: capabilities,
        configSchema: { greeting: { type: "string", required: true, minLength: 1, maxLength: 256 } } }));
      const bundle = (await run(cli, ["bundle", "--entry", "entry.ts", "--out", "entry.bundle.mjs"], true))!;
      expect(bundle.ok && bundle.command === "bundle").toBe(true);
      const entry = await readFile(join(root, "entry.bundle.mjs"));
      expect(sha256(entry)).toBe(bundle.entrySha256);
      expect(/\bimport\s|@vrata\/|runtime-web|workspace:/.test(entry.toString("utf8"))).toBe(false);
      const packed = (await run(cli, ["pack", "--manifest", "manifest.json", "--entry", "entry.bundle.mjs", "--out", "example.vrata-plugin.json"], true))!;
      const validated = (await run(cli, ["validate", "example.vrata-plugin.json"], true))!;
      expect(packed.ok && packed.command === "pack" && validated.ok && validated.command === "validate").toBe(true);
      const bytes = await readFile(join(root, "example.vrata-plugin.json"));
      expect(sha256(bytes)).toBe(packed.artifactSha256);
      expect(validated.artifactSha256).toBe(packed.artifactSha256);
      expect(validated.entrySha256).toBe(bundle.entrySha256);
      expect(bytes.byteLength).toBe(validated.bytes);
      await assertNotExecuted();
      return { bytes, artifactSha256: sha256(bytes), entrySha256: bundle.entrySha256, pluginId, version, capabilities };
    }
    async function assertNotExecuted() {
      let exists = true;
      try { await access(markerPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("plugin_author_marker_check_failed");
        exists = false;
      }
      expect(exists).toBe(false);
    }
    return { build, close, assertNotExecuted };
  } catch {
    await close();
    throw new Error("plugin_author_external_project_setup_failed");
  }
}

// Browser-facing byte transport only: do not import/eval the downloaded entry or
// call the sandbox probe. Author UI (T08) and VM/broker execution are separate gates.
export async function browserContent(page: Page, path: string, token: string) {
  try {
    return await page.evaluate(async ({ path, token, marker }) => {
      const response = await fetch(path, { headers: { authorization: `Bearer ${token}` }, credentials: "omit", cache: "no-store" });
      const bytes = await response.arrayBuffer();
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
      return { status: response.status, artifactSha256: digest, declaredSha256: response.headers.get("x-artifact-sha256"),
        nativeExecuted: Reflect.has(globalThis, marker) };
    }, { path, token, marker: nativeMarker });
  } catch { throw new Error("plugin_author_browser_content_transport_failed"); }
}
