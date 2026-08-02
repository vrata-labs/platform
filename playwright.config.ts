import { defineConfig } from "playwright/test";
import { join, resolve } from "node:path";

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
const excludeRuntimeSpec = process.env.E2E_EXCLUDE_RUNTIME_SPEC === "1";
const artifactRoot = process.env.E2E_ARTIFACT_ROOT ? resolve(process.env.E2E_ARTIFACT_ROOT) : null;
const outputDir = artifactRoot ? join(artifactRoot, "test-results", reportName) : `test-results/${reportName}`;
const htmlReportDir = artifactRoot ? join(artifactRoot, "playwright-report", reportName) : `playwright-report/${reportName}`;
const jsonReportPath = artifactRoot ? join(artifactRoot, "test-results", `${reportName}.json`) : `test-results/${reportName}.json`;

process.env.E2E_ROOM_STATE_PUBLIC_URL ??= roomStateUrl;

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: excludeRuntimeSpec ? ["**/runtime.spec.ts"] : [],
  timeout: 45000,
  outputDir,
  reporter: [
    ["list"],
    ["html", { outputFolder: htmlReportDir, open: "never" }],
    ["json", { outputFile: jsonReportPath }]
  ],
  use: {
    baseURL,
    headless: true,
    screenshot: "only-on-failure",
    trace: process.env.PLAYWRIGHT_TRACE === "1" ? "retain-on-failure" : "off"
  },
  webServer: useWebServer ? {
    command: "node tools/start-e2e-services.mjs",
    url: new URL("/health", baseURL).toString(),
    reuseExistingServer: process.env.E2E_REUSE_EXISTING_SERVER === "1",
    timeout: 120000,
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
      SCENE_BUNDLE_LOCAL_UPLOAD_ROOT: process.env.SCENE_BUNDLE_LOCAL_UPLOAD_ROOT ?? "/tmp/vrata-e2e-scene-bundles",
      DOCUMENT_LOCAL_UPLOAD_ROOT: process.env.DOCUMENT_LOCAL_UPLOAD_ROOT ?? "/tmp/vrata-e2e-documents",
      REMOTE_BROWSER_VIEWPORT_MOCK: "1",
      REMOTE_BROWSER_ALLOWED_ORIGINS: allowedOrigins,
      REMOTE_BROWSER_ALLOW_PRIVATE_ALLOWED_ORIGINS: "true"
    }
  } : undefined
});
