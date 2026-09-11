// Diagnostic only: never substitutes for the unmodified staging acceptance suite.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const base = 'https://158.160.10.234.sslip.io';
const index = JSON.parse(await fs.readFile(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'vrata-scene-probe-cache/index.json'), 'utf8'));
const rooms = {Hall: '42db8225-f671-4e46-9c28-9381d66a948c', BlueOffice: '0b537d34-7b92-4b51-854a-8c64cfb4c114'};
const browser = await chromium.launch({headless: true});
try {
  for (const [scene, id] of Object.entries(rooms)) {
    for (const mode of ['network', 'local-asset-control', 'network']) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      const entries = new Map();
      const started = Date.now();
      const relative = () => Date.now() - started;
      cdp.on('Network.requestWillBeSent', e => {
        if (e.request.url.includes('/assets/scenes/')) entries.set(e.requestId, {url: e.request.url, start_ms: relative(), bytes: 0});
      });
      cdp.on('Network.responseReceived', e => {
        const a = entries.get(e.requestId);
        if (a) Object.assign(a, {headers_ms: relative(), status: e.response.status, protocol: e.response.protocol, fromDiskCache: e.response.fromDiskCache, contentLength: e.response.headers['content-length'] ?? e.response.headers['Content-Length'], timing: e.response.timing});
      });
      cdp.on('Network.dataReceived', e => {
        const a = entries.get(e.requestId);
        if (a) {a.bytes += e.dataLength; a.last_data_ms = relative();}
      });
      cdp.on('Network.loadingFinished', e => {
        const a = entries.get(e.requestId);
        if (a) Object.assign(a, {finished_ms: relative(), encoded_bytes: e.encodedDataLength});
      });
      cdp.on('Network.loadingFailed', e => {
        const a = entries.get(e.requestId);
        if (a) Object.assign(a, {failed_ms: relative(), error: e.errorText});
      });
      if (mode === 'local-asset-control') {
        const candidates = index.filter(a => a.scene === scene && a.cache_file);
        const buffers = new Map(await Promise.all(candidates.map(async a => [a.url, await fs.readFile(a.cache_file)])));
        await page.route('**/assets/scenes/**/*.glb', async route => {
          const body = buffers.get(route.request().url());
          if (body) await route.fulfill({status: 200, contentType: 'model/gltf-binary', headers: {'access-control-allow-origin': '*'}, body});
          else await route.continue();
        });
      }
      const stages = [];
      let last = '';
      let final = null;
      let error = null;
      try {
        await page.goto(`${base}/rooms/${id}?debug=1`, {timeout: 30000, waitUntil: 'domcontentloaded'});
        while (relative() < 90000) {
          final = await page.evaluate(() => {
            const d = window.__VRATA_DEBUG__;
            if (!d) return null;
            const s = d.sceneDebug ?? {};
            return {sceneBundleState: d.sceneBundleState, sceneDebug: {bundleUrl: s.bundleUrl, state: s.state, failureReason: s.failureReason, loadStage: s.loadStage, assetBytesLoaded: s.assetBytesLoaded, assetBytesExpected: s.assetBytesExpected, loadMs: s.loadMs, meshCount: s.meshCount}};
          });
          const key = JSON.stringify([final?.sceneBundleState, final?.sceneDebug?.state, final?.sceneDebug?.loadStage]);
          if (key !== last) {stages.push({at_ms: relative(), ...final}); last = key;}
          if (final?.sceneDebug?.state === 'loaded') break;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (e) { error = e.message; }
      console.log(JSON.stringify({kind: 'browser_probe', scene, mode, elapsed_ms: relative(), error, stages, final, requests: [...entries.values()]}));
      await context.close();
    }
  }
} finally { await browser.close(); }
