import { bootRuntime } from "./index.js";

async function main(): Promise<void> {
  const apiBaseUrl = (globalThis as { __NOAH_API_BASE_URL__?: string }).__NOAH_API_BASE_URL__ ?? "http://localhost:4000";
  const roomId = "demo-room";

  try {
    const boot = await bootRuntime(apiBaseUrl, roomId, navigator.userAgent);
    console.log("runtime_boot", boot);
  } catch (error) {
    console.error("runtime_boot_failed", error);
  }
}

void main();
