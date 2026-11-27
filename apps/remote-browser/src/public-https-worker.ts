import { spawn, execFile, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { Page, Request } from "playwright-core";
import type { RemoteBrowserSiteIssue } from "@vrata/shared-types";
import { enforceWorkerDeadline, publicHttpsSlots, publicHttpsWorkerDirectory as directory, publicHttpsWorkerReady, publicHttpsWorkerProxyDirectory, readMessages, writeMessage, type PublicHttpsInput } from "./public-https-channel.js";
import { openIsolatedChromium } from "./public-https-chromium.js";
import { parsePublicHttpsTarget } from "./url-policy.js";

const exec = promisify(execFile);
const workerPath = (name: string) => join(directory, name);

export function siteIssueFromGateway(code: string | undefined): RemoteBrowserSiteIssue | null {
  switch (code) {
    case "scheme_not_allowed": return "room_policy";
    case "private_address": return "private_destination";
    case "dns_failed":
    case "target_unavailable": return "site_unavailable";
    default: return null;
  }
}

async function startSession(socket: Socket, slot: number) {
  const controller = new AbortController();
  const { signal } = controller;
  const children: { child: ChildProcess; closed: Promise<unknown> }[] = [];
  let chromium: Awaited<ReturnType<typeof openIsolatedChromium>> | undefined;
  let page: Page | undefined;
  let authorized = false;
  let launched = false;
  let ready = false;
  let opening: Promise<void> | undefined;
  const stop = () => socket.destroy();
  const lease = enforceWorkerDeadline(stop);
  const display = `:${slot}`;
  const pulseServer = `unix:${workerPath("pulse.sock")}`;
  const size = { width: 1280, height: 720 };
  const finished = new Promise<void>(resolve => socket.once("close", resolve));
  const start = (command: string, args: string[]) => {
    const child = spawn(command, args, { stdio: "ignore" });
    children.push({ child, closed: new Promise(resolve => child.once("close", resolve)) });
    child.once("error", stop);
    child.once("exit", stop);
  };
  const issues = { navigation: null, resource: null } as Record<"navigation" | "resource", RemoteBrowserSiteIssue | null>;
  const sendIssue = (scope: "navigation" | "resource", issue: RemoteBrowserSiteIssue | null) => {
    // Resource fan-out must not flood the callback channel or replace a
    // navigation refusal. One warning is enough until the next document.
    if (issues[scope] === issue || (scope === "resource" && issues.resource && issue)) return;
    issues[scope] = issue;
    writeMessage(socket, { type: "issue", scope, issue });
  };

  async function open(url: string) {
    if (!parsePublicHttpsTarget(url)) {
      sendIssue("navigation", "room_policy");
      writeMessage(socket, { type: "rejected", issue: "room_policy" });
      return;
    }
    await mkdir("/tmp/pulse", { recursive: true, mode: 0o700 });
    const pulseSocket = workerPath("pulse.sock");
    await rm(pulseSocket, { force: true });
    signal.throwIfAborted();
    start("Xvfb", [display, "-nolisten", "tcp", "-ac", "-screen", "0", `${size.width}x${size.height}x24`]);
    start("pulseaudio", ["-n", "--daemonize=no", "--exit-idle-time=-1",
      "--load=module-null-sink sink_name=vrata_browser rate=48000",
      `--load=module-native-protocol-unix socket=${pulseSocket} auth-anonymous=1`]);
    while (!signal.aborted) {
      try {
        await Promise.all([
          exec("xdpyinfo", ["-display", display], { signal, timeout: 500 }),
          exec("pactl", ["-s", pulseServer, "info"], { signal, timeout: 500 })
        ]);
        break;
      } catch {
        await delay(100, undefined, { signal });
      }
    }
    chromium = await openIsolatedChromium({
      socketPath: join(publicHttpsWorkerProxyDirectory, "proxy.sock"), proxyCertificate: join(publicHttpsWorkerProxyDirectory, "ca.pem"),
      headless: false, display, pulseServer, viewport: size, signal
    });
    const context = chromium.context;
    page = await context.newPage();
    page.once("close", stop);
    page.once("crash", stop);
    const primary = page;
    context.on("page", extra => { if (extra !== primary) void extra.close().catch(() => {}); });
    const requestGeneration = new WeakMap<Request, number>();
    let generation = 0;
    let initialIssue: RemoteBrowserSiteIssue | null = null;
    const isNavigation = (request: Request) => {
      try { return request.isNavigationRequest() && request.frame() === primary.mainFrame(); }
      catch { return false; }
    };
    const report = (request: Request, issue: RemoteBrowserSiteIssue | null) => {
      if (requestGeneration.get(request) !== generation) return;
      if (isNavigation(request)) {
        if (!ready) initialIssue = issue;
        sendIssue("navigation", issue);
      } else if (issue) sendIssue("resource", issue);
    };
    primary.on("request", request => {
      if (isNavigation(request)) {
        generation += 1;
        sendIssue("resource", null);
      }
      requestGeneration.set(request, generation);
    });
    primary.on("response", response => {
      const issue = siteIssueFromGateway(response.headers()["x-vrata-browser-error"]);
      if (issue || (isNavigation(response.request()) && response.status() >= 400)) report(response.request(), issue ?? "site_unavailable");
      else if (isNavigation(response.request()) && response.status() < 300) report(response.request(), null);
    });
    primary.on("requestfailed", request => {
      const error = request.failure()?.errorText;
      if (error !== "net::ERR_ABORTED") report(request, parsePublicHttpsTarget(request.url()) ? "site_unavailable" : "room_policy");
    });
    await context.route("**/*", async route => {
      if (parsePublicHttpsTarget(route.request().url())) return route.continue();
      report(route.request(), "room_policy");
      await route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", route => {
      sendIssue("resource", "room_policy");
      void route.close().catch(() => {});
    });
    let navigated = false;
    try {
      await primary.goto(url, { waitUntil: "domcontentloaded", timeout: 8500 });
      navigated = true;
    } catch {
      // Chromium errors include the navigate URL and browser internals.
    }
    signal.throwIfAborted();
    if (!navigated || initialIssue) {
      writeMessage(socket, { type: "rejected", issue: initialIssue ?? "site_unavailable" });
      return;
    }
    ready = true;
    await primary.bringToFront();
    writeMessage(socket, { type: "opened" });
  }

  readMessages(socket, message => {
    const payload = message as { type?: unknown; deadline?: unknown; url?: unknown; patch?: PublicHttpsInput };
    if (payload.type === "deadline") {
      authorized = lease.set(payload.deadline);
      return;
    }
    if (!authorized) return stop();
    if (payload.type === "open" && !launched && typeof payload.url === "string") {
      launched = true;
      opening = open(payload.url).catch(() => { writeMessage(socket, { type: "failed" }); });
      return;
    }
    const patch = payload.patch;
    if (payload.type === "input" && page && ready && patch) {
      void applyInput(page, patch, size).catch(() => {});
    }
  });
  await finished;
  controller.abort();
  lease.clear();
  for (const { child } of children) child.kill("SIGKILL");
  await opening;
  await chromium?.close().catch(() => {});
  await Promise.all(children.map(({ closed }) => closed));
  await Promise.all(["pulse.sock", `X${slot}`, `/tmp/.X${slot}-lock`].map(name =>
    rm(name.startsWith("/") ? name : workerPath(name), { force: true })));
}

async function applyInput(page: Page, patch: PublicHttpsInput, size: { width: number; height: number }) {
  const event = patch.event;
  const x = Math.max(0, Math.min(size.width - 1, Math.round((event.uv?.u ?? 0.5) * size.width)));
  const y = Math.max(0, Math.min(size.height - 1, Math.round((1 - (event.uv?.v ?? 0.5)) * size.height)));
  if (patch.type === "keyboard") {
    if (event.kind === "key-down" && event.text) await page.keyboard.insertText(event.text);
    else if (event.kind === "key-down" && event.key) await page.keyboard.press(event.key);
    return;
  }
  await page.mouse.move(x, y);
  if (patch.type === "scroll") await page.mouse.wheel(event.scrollDelta?.x ?? 0, event.scrollDelta?.y ?? 480);
  else if (event.kind === "pointer-down") await page.mouse.down();
  else if (event.kind === "pointer-up") await page.mouse.up();
  else if (event.kind === "click") await page.mouse.click(x, y);
}

async function main() {
  const slot = publicHttpsSlots.find(candidate => String(candidate) === process.argv[2]);
  if (!slot || Object.values(networkInterfaces()).flat().some(address => address && !address.internal)) {
    throw new Error("isolated_worker_required");
  }
  process.env.XDG_RUNTIME_DIR = "/tmp/pulse";
  process.env.HOME = "/tmp";
  const path = workerPath("worker.sock");
  const readyPath = workerPath(publicHttpsWorkerReady);
  await Promise.all([path, readyPath].map(file => rm(file, { force: true })));
  let busy = false;
  const server = createServer(socket => {
    if (busy) return socket.destroy();
    busy = true;
    rmSync(readyPath, { force: true });
    void startSession(socket, slot).then(async () => {
      busy = false;
      await writeFile(readyPath, "");
    }).catch(() => {
      // A failed cleanup cannot leave a slot eligible for reuse.
      process.exit(1);
    });
  });
  server.listen(path);
  await once(server, "listening");
  await chmod(path, 0o600);
  await writeFile(readyPath, "");
}

void main().catch(() => {
  console.error("public_https_worker_start_failed");
  process.exit(1);
});
