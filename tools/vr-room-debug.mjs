#!/usr/bin/env node

const baseUrl = process.env.BASE_URL ?? "https://158.160.10.234.sslip.io";
const adminToken = process.env.STAGING_ADMIN_TOKEN ?? process.env.VRATA_ADMIN_TOKEN ?? "vrata-stage-admin";

function parseArgs(argv) {
  const options = {
    roomId: process.env.ROOM_ID ?? null,
    roomUrl: process.env.ROOM_URL ?? null,
    avatarVrMock: false,
    durationMs: Number.parseInt(process.env.VR_DEBUG_DURATION_MS ?? "30000", 10),
    intervalMs: Number.parseInt(process.env.VR_DEBUG_INTERVAL_MS ?? "1000", 10),
    includeDiagnostics: true,
    includeTelemetry: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--room-id" && next) {
      options.roomId = next;
      index += 1;
      continue;
    }
    if (arg === "--room-url" && next) {
      options.roomUrl = next;
      index += 1;
      continue;
    }
    if (arg === "--avatarvrmock") {
      options.avatarVrMock = true;
      continue;
    }
    if (arg === "--duration-ms" && next) {
      options.durationMs = Number.parseInt(next, 10);
      index += 1;
      continue;
    }
    if (arg === "--interval-ms" && next) {
      options.intervalMs = Number.parseInt(next, 10);
      index += 1;
      continue;
    }
    if (arg === "--no-diagnostics") {
      options.includeDiagnostics = false;
      continue;
    }
    if (arg === "--no-telemetry") {
      options.includeTelemetry = false;
      continue;
    }
    if (arg === "--help") {
      process.stdout.write([
        "Usage: node tools/vr-room-debug.mjs --room-id <id> [--avatarvrmock] [--duration-ms 30000] [--interval-ms 1000]",
        "   or: node tools/vr-room-debug.mjs --room-url <full room url>"
      ].join("\n") + "\n");
      process.exit(0);
    }
    throw new Error(`unknown_argument:${arg}`);
  }

  if (!options.roomUrl && !options.roomId) {
    throw new Error("room_id_or_room_url_required");
  }

  return options;
}

function resolveRoomUrl(options) {
  if (options.roomUrl) {
    return options.roomUrl;
  }
  const url = new URL(`/rooms/${options.roomId}`, baseUrl);
  url.searchParams.set("debug", "1");
  if (options.avatarVrMock) {
    url.searchParams.set("avatarvrmock", "1");
  }
  return url.toString();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "x-vrata-admin-token": adminToken
    }
  });
  if (!response.ok) {
    throw new Error(`fetch_failed:${response.status}:${url}`);
  }
  return response.json();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const roomUrl = resolveRoomUrl(options);
  const roomId = options.roomId ?? new URL(roomUrl).pathname.split("/").filter(Boolean).at(-1) ?? null;
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.goto(roomUrl, { waitUntil: "domcontentloaded" });

    const snapshots = [];
    const startedAt = Date.now();
    while (Date.now() - startedAt <= options.durationMs) {
      const snapshot = await page.evaluate(() => {
        const d = (window).__VRATA_DEBUG__ ?? null;
        if (!d) return null;
        return {
          atMs: Date.now(),
          sceneBundleUrl: d.sceneBundleUrl ?? null,
          sceneBundleState: d.sceneBundleState ?? null,
          roomStateConnected: d.roomStateConnected ?? null,
          statusLine: d.statusLine ?? null,
          currentSeatId: d.currentSeatId ?? null,
          localPosition: d.localPosition ?? null,
          interactionRay: d.interactionRay ?? null,
          avatarSnapshot: d.avatarSnapshot ? {
            inputMode: d.avatarSnapshot.inputMode ?? null,
            visibilityState: d.avatarSnapshot.visibilityState ?? null
          } : null,
          sceneDebug: d.sceneDebug ? {
            state: d.sceneDebug.state ?? null,
            loadStage: d.sceneDebug.loadStage ?? null,
            assetBytesLoaded: d.sceneDebug.assetBytesLoaded ?? null,
            assetBytesExpected: d.sceneDebug.assetBytesExpected ?? null,
            failureReason: d.sceneDebug.failureReason ?? null,
            loadMs: d.sceneDebug.loadMs ?? null
          } : null
        };
      });
      snapshots.push(snapshot);
      await page.waitForTimeout(options.intervalMs);
    }

    const output = {
      roomId,
      roomUrl,
      durationMs: options.durationMs,
      intervalMs: options.intervalMs,
      snapshots,
      diagnostics: null,
      xrTelemetry: null
    };

    if (roomId && options.includeDiagnostics) {
      output.diagnostics = await fetchJson(new URL(`/api/rooms/${roomId}/diagnostics`, baseUrl));
    }
    if (roomId && options.includeTelemetry) {
      output.xrTelemetry = await fetchJson(new URL(`/api/rooms/${roomId}/xr-telemetry`, baseUrl));
    }

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    await page.close();
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
