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
    command: "bash -lc 'node apps/room-state/dist/index.js >/tmp/noah-room-state.log 2>&1 & node apps/api/dist/index.js'",
    url: "http://127.0.0.1:4000/health",
    reuseExistingServer: true,
    env: {
      NOAH_DISABLE_AUTOSTART: "0",
      CONTROL_PLANE_ADMIN_TOKEN: "test-admin-token"
    }
  } : undefined
});
