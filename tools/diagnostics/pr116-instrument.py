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
 '    probe.mark("start-click");\n    await page.locator("#start-share").click();\n    probe.mark("publication-poll-start");\n    await expect.poll(() => page.evaluate(() => {',
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
