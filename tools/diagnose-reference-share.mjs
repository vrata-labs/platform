import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
const base = process.env.BASE_URL;
const roomId = "fd4ea01c-fea8-48ff-af6c-65be4004bbc5";
const headers = { "content-type": "application/json", "x-vrata-admin-token": process.env.STAGING_ADMIN_TOKEN };
const call = (path, options = {}) => fetch(new URL(path, base), { ...options, headers, signal: AbortSignal.timeout(15000) });
const record = await (await call(`/api/rooms/${roomId}`)).json();
if (record.name !== "Reference media diagnostic" || record.templateVersion !== "2.0.0" || record.templateId !== "presentation-room-basic") throw new Error("diagnostic_room_mismatch");
if (!(await call(`/api/rooms/${roomId}`, { method: "PATCH", body: JSON.stringify({ sessionControl: {} }) })).ok) throw new Error("diagnostic_reset_failed");
const inviteResponse = await call(`/api/rooms/${roomId}/invites`, { method: "POST", body: JSON.stringify({ role: "host", expiresInSeconds: 600 }) });
if (!inviteResponse.ok) throw new Error(`invite_status:${inviteResponse.status}`);
const hostLink = new URL((await inviteResponse.json()).inviteLink);
hostLink.searchParams.set("debug", "1"); hostLink.searchParams.set("scenefit", "0");
const result = { roomId, events: [], before: null, after: null, failure: null };
const redact = text => String(text).replace(/\b\w+:\/\/[^\s"']+/g, "[url]").replace(/\beyJ[A-Za-z0-9_.-]+/g, "[token]").replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "[address]").slice(0, 500);
const browser = await chromium.launch({ headless: true });
const host = await browser.newPage({ viewport: { width: 640, height: 400 } });
const peer = await browser.newPage({ viewport: { width: 640, height: 400 } });
const state = page => page.evaluate(() => {
  const d = window.__VRATA_DEBUG__;
  return { scene: d?.sceneBundleState, status: d?.statusLine, issue: d?.issueCode, mediaState: d?.media?.audioState, publishedAudio: d?.media?.publishedAudio, rtcAvailable: d?.media?.webrtc?.available, transportCount: d?.media?.webrtc?.transports?.length, share: d?.screenShare, blockedReason: d?.mediaObjects?.blockedReason };
});
for (const [page, name] of [[host, "host"], [peer, "peer"]]) {
  page.on("console", message => { if (message.type() === "error") result.events.push({ name, error: redact(message.text()) }); });
  page.on("response", response => { if (new URL(response.url()).pathname === "/api/tokens/media") result.events.push({ name, endpoint: "/api/tokens/media", status: response.status() }); });
}
try {
  await host.goto(hostLink.href);
  await host.waitForFunction(() => window.__VRATA_DEBUG__?.roomStateConnected || document.querySelector("#guest-onboarding")?.hidden === false, null, { timeout: 30000 });
  if (await host.locator("#guest-onboarding").isVisible()) {
    await host.locator("#guest-name-input").fill("Reference participant");
    await host.locator("#guest-enter-without-audio").click();
  }
  await host.waitForFunction(() => window.__VRATA_DEBUG__?.sceneBundleState === "loaded" && window.__VRATA_DEBUG__?.roomStateConnected, null, { timeout: 120000 });
  await peer.goto(`${base}/rooms/${roomId}?debug=1&scenefit=0&onboard=0`);
  await peer.waitForFunction(() => window.__VRATA_DEBUG__?.sceneBundleState === "loaded" && window.__VRATA_DEBUG__?.roomStateConnected, null, { timeout: 120000 });
  await host.evaluate(() => window.__VRATA_TEST__.stopActiveSurfaceObject("debug-main"));
  await host.waitForFunction(() => !window.__VRATA_DEBUG__?.mediaObjects?.surfaces?.find(s => s.surfaceId === "debug-main")?.activeObjectType, null, { timeout: 15000 });
  result.before = { host: await state(host), peer: await state(peer) };
  await host.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 90;
    const ctx = canvas.getContext("2d");
    const frame = () => { ctx.fillStyle = Math.floor(performance.now() / 650) % 2 ? "#e82020" : "#2040e8"; ctx.fillRect(0, 0, 160, 90); };
    frame(); setInterval(frame, 100);
    const stream = canvas.captureStream(10);
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", { configurable: true, value: async () => stream });
  });
  await host.locator("#start-share").click();
  await host.waitForFunction(() => {
    const s = window.__VRATA_DEBUG__?.screenShare;
    return s?.localPublishing && s?.publishedTrackSid && !s.publishedTrackSid.startsWith("mock-");
  }, null, { timeout: 45000 });
} catch (error) {
  result.failure = redact(error.message);
  process.exitCode = 1;
} finally {
  result.after = { host: await state(host).catch(() => null), peer: await state(peer).catch(() => null) };
  await browser.close();
  await mkdir("test-results", { recursive: true });
  await writeFile("test-results/reference-share-diagnostic.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
