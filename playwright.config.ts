import { defineConfig } from "playwright/test";

const baseUrlPort = process.env.BASE_URL ? new URL(process.env.BASE_URL).port : "";
const apiPort = (process.env.E2E_API_PORT ?? process.env.API_PORT ?? baseUrlPort) || "4000";
const roomStatePort = process.env.E2E_ROOM_STATE_PORT ?? process.env.ROOM_STATE_PORT ?? "2567";
const remoteBrowserPort = process.env.E2E_REMOTE_BROWSER_PORT ?? process.env.REMOTE_BROWSER_PORT ?? "4010";
const baseURL = process.env.BASE_URL ?? `http://127.0.0.1:${apiPort}`;
const baseUrlOrigin = new URL(baseURL).origin;
const apiInternalUrl = `http://127.0.0.1:${apiPort}`;
const roomStateUrl = process.env.E2E_ROOM_STATE_PUBLIC_URL ?? `ws://127.0.0.1:${roomStatePort}`;
const remoteBrowserUrl = `ws://127.0.0.1:${remoteBrowserPort}`;
const allowedOrigins = `${baseUrlOrigin},http://localhost:${apiPort},http://127.0.0.1:${apiPort}`;
const useWebServer = process.env.PLAYWRIGHT_NO_WEB_SERVER !== "1";
const reportName = process.env.PLAYWRIGHT_REPORT_NAME ?? "e2e";

process.env.E2E_ROOM_STATE_PUBLIC_URL ??= roomStateUrl;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45000,
  outputDir: `test-results/${reportName}`,
  reporter: [
    ["list"],
    ["html", { outputFolder: `playwright-report/${reportName}`, open: "never" }],
    ["json", { outputFile: `test-results/${reportName}.json` }]
  ],
  use: {
    baseURL,
    headless: true,
    screenshot: "only-on-failure",
    trace: process.env.PLAYWRIGHT_TRACE === "1" ? "retain-on-failure" : "off"
  },
  webServer: useWebServer ? {
    command: "bash -lc 'node apps/remote-browser/dist/index.js >/tmp/vrata-remote-browser.log 2>&1 & node apps/room-state/dist/index.js >/tmp/vrata-room-state.log 2>&1 & node apps/api/dist/index.js'",
    url: new URL("/health", baseURL).toString(),
    reuseExistingServer: true,
    env: {
      VRATA_DISABLE_AUTOSTART: "0",
      API_PORT: apiPort,
      ROOM_STATE_PORT: roomStatePort,
      REMOTE_BROWSER_PORT: remoteBrowserPort,
      CONTROL_PLANE_ADMIN_TOKEN: "test-admin-token",
      FEATURE_AVATAR_POSE_BINARY: "true",
      REMOTE_BROWSER_INTERNAL_URL: `http://127.0.0.1:${remoteBrowserPort}`,
      REMOTE_BROWSER_PUBLIC_URL: remoteBrowserUrl,
      VRATA_INTERNAL_SERVICE_TOKEN: "test-internal-token",
      API_INTERNAL_URL: apiInternalUrl,
      ROOM_STATE_INTERNAL_URL: `http://127.0.0.1:${roomStatePort}`,
      ROOM_STATE_PUBLIC_URL: roomStateUrl,
      REMOTE_BROWSER_VIEWPORT_MOCK: "1",
      REMOTE_BROWSER_ALLOWED_ORIGINS: allowedOrigins,
      REMOTE_BROWSER_ALLOW_PRIVATE_ALLOWED_ORIGINS: "true"
    }
  } : undefined
});
