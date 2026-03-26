import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:4000",
    headless: true
  },
  webServer: {
    command: "node apps/api/dist/index.js",
    url: "http://127.0.0.1:4000/health",
    reuseExistingServer: true,
    env: {
      NOAH_DISABLE_AUTOSTART: "0",
      CONTROL_PLANE_ADMIN_TOKEN: "test-admin-token"
    }
  }
});
