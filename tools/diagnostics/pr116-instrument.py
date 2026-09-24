from pathlib import Path

path = Path('tests/e2e/reference-template-scenarios.ts')
source = path.read_text()
updates = {
 'import { randomUUID } from "node:crypto";': 'import { randomUUID } from "node:crypto";\nimport { observeScreenShare } from "./diagnostics/pr116-share-probe.js";',
 '  const events: Array<{ peer: string; category: string; status?: number }> = [];':
 '  const events: Array<{ peer: string; category: string; status?: number }> = [];\n  const probe = await observeScreenShare([[page, "publisher"], [observer, "viewer"]]);',
 '      Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", { configurable: true, value: async () => stream });':
 '''      let captureCalls = 0;
      Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", { configurable: true, value: async () => { captureCalls++; return stream; } });
      (window as any).__referenceCaptureProbe = () => ({ calls: captureCalls, tracks: stream.getVideoTracks().map(track => ({ ready: track.readyState, enabled: track.enabled, muted: track.muted, width: track.getSettings().width ?? null, height: track.getSettings().height ?? null })) });''',
 '    await page.locator("#start-share").click();\n    await expect.poll(() => page.evaluate(() => {':
 '    probe.mark("start-click");\n    await page.locator("#start-share").click();\n    await expect.poll(() => page.evaluate(() => {',
 '    await expect.poll(() => observer.evaluate(() => (window as any).__VRATA_DEBUG__?.screenShare?.remoteSubscribedTrackCount ?? 0), { timeout: 45000 }).toBe(1);':
 '    probe.mark("publication-confirmed");\n    await expect.poll(() => observer.evaluate(() => (window as any).__VRATA_DEBUG__?.screenShare?.remoteSubscribedTrackCount ?? 0), { timeout: 45000 }).toBe(1);',
 '    await expect.poll(receivedColor, { timeout: 30000 }).toBe("red");':
 '    await expect.poll(receivedColor, { timeout: 30000 }).toBe("red");\n    probe.mark("red-received");',
 '    await expect.poll(receivedColor, { timeout: 30000 }).toBe("blue");':
 '    await expect.poll(receivedColor, { timeout: 30000 }).toBe("blue");\n    probe.mark("blue-received");',
 '    await page.evaluate(() => (window as any).__stopReferenceCapture?.()).catch(() => undefined);':
 '    await probe.stop();\n    await page.evaluate(() => (window as any).__stopReferenceCapture?.()).catch(() => undefined);'
}
for original, replacement in updates.items():
    assert source.count(original) == 1, original[:100]
    source = source.replace(original, replacement)
path.write_text(source)
print('diagnostic_instrumentation_applied:8_exact_sites')

probe_path = Path('tests/e2e/diagnostics/pr116-share-probe.ts')
probe = probe_path.read_text()
probe_updates = {
 'import { test, type Page } from "@playwright/test";': 'import { test, type Page } from "@playwright/test";\nimport { readFileSync } from "node:fs";\nimport { createHash } from "node:crypto";',
 'export function observeScreenShare(': 'export async function observeScreenShare(',
 '  const started = performance.now();': '''  const variant = test.info().repeatEachIndex % 2 === 0 ? "baseline" : "candidate";
  const bundle = readFileSync(`diagnostic-bundles/${variant}.js`);
  const bundleSha256 = createHash("sha256").update(bundle).digest("hex");
  const expectedHash = variant === "baseline" ? "6685a20d20277c5930b8e1c7e106ab6bb7f77454e559c64d265f85f5581e2615" : "596f0a89cf0b4dbc3b9676fed6f99798f7e27cf12f8797890fc1c5027d90a5db";
  if (bundleSha256 !== expectedHash) throw new Error("diagnostic_bundle_hash_mismatch");
  const clientSourceSha = variant === "baseline" ? "54e13fec4ee14134597c6520a3cfa9b0db291032" : "4ba3fc6d8e0d667bd69143e749d0dc94f0846997";
  const served = new Map<Peer, number>();
  const started = performance.now();''',
 '  for (const [page, peer] of clients) {\n    page.on': '''  for (const [page, peer] of clients) {
    // Both variants use identical local delivery; all other assets and transport stay real.
    await page.route(url => url.pathname === "/assets/main-DX4Wj_52.js", async route => {
      served.set(peer, (served.get(peer) ?? 0) + 1);
      record(peer, "client-bundle", { variant, bundleSha256 });
      await route.fulfill({ status: 200, contentType: "application/javascript", body: bundle, headers: { "cache-control": "no-store" } });
    });
    page.on''',
 'JSON.stringify({ version: 1, deployedSha:': 'JSON.stringify({ version: 2, variant, clientSourceSha, bundleSha256, bundleRequests: Object.fromEntries(served), deployedSha:'
}
for original, replacement in probe_updates.items():
    assert probe.count(original) == 1, original[:100]
    probe = probe.replace(original, replacement)
probe_path.write_text(probe)
print('diagnostic_client_variants_instrumented:5_exact_sites')
