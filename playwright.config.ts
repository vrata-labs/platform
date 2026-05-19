import { defineConfig } from "playwright/test";

const baseURL = process.env.BASE_URL ?? "http://127.0.0.1:4000";
const useWebServer = process.env.PLAYWRIGHT_NO_WEB_SERVER !== "1";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30000,
  use: {
    baseURL,
    headless: true
  },
  webServer: useWebServer ? {
    command: "bash -lc 'node apps/remote-browser/dist/index.js >/tmp/noah-remote-browser.log 2>&1 & node apps/room-state/dist/index.js >/tmp/noah-room-state.log 2>&1 & node apps/api/dist/index.js'",
    url: "http://127.0.0.1:4000/health",
    reuseExistingServer: true,
    env: {
      NOAH_DISABLE_AUTOSTART: "0",
      CONTROL_PLANE_ADMIN_TOKEN: "test-admin-token",
      FEATURE_AVATAR_POSE_BINARY: "true",
      REMOTE_BROWSER_INTERNAL_URL: "http://127.0.0.1:4010",
      REMOTE_BROWSER_PUBLIC_URL: "ws://127.0.0.1:4010",
      NOAH_INTERNAL_SERVICE_TOKEN: "test-internal-token",
      API_INTERNAL_URL: "http://127.0.0.1:4000",
      ROOM_STATE_INTERNAL_URL: "http://127.0.0.1:2567",
      REMOTE_BROWSER_VIEWPORT_MOCK: "1",
      REMOTE_BROWSER_ALLOWED_ORIGINS: "http://127.0.0.1:4000,http://localhost:4000",
      REMOTE_BROWSER_ALLOW_PRIVATE_ALLOWED_ORIGINS: "true"
    }
  } : undefined
});
