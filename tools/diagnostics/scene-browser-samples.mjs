// Diagnostic only: compare delivery on unchanged staging, not release acceptance.
import { chromium } from 'playwright';
const base = 'https://158.160.10.234.sslip.io';
const previous = '6110679a24c2a95179729b2f8c2c1a20f3227c50';
const scenes = [
  { name: 'Hall', room: '42db8225-f671-4e46-9c28-9381d66a948c', folder: 'sense-hall2-v1' },
  { name: 'BlueOffice', room: '0b537d34-7b92-4b51-854a-8c64cfb4c114', folder: 'sense-blueoffice-glb-v4' }
];
const buffers = new Map();
for (const scene of scenes) {
  const url = `https://state.158.160.10.234.sslip.io/assets/scenes/${scene.folder}/${previous}/scene.glb`;
  const response = await fetch(url, { signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new Error(`fixture_http_${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length !== Number(response.headers.get('content-length'))) throw new Error('fixture_size_mismatch');
  buffers.set(url, data);
}
const browser = await chromium.launch({ headless: true });
async function sample(scene, mode, round) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const entries = new Map();
  const start = Date.now();
  const clock = () => Date.now() - start;
  cdp.on('Network.requestWillBeSent', e => {
    if (e.request.url.includes('/assets/scenes/')) entries.set(e.requestId, { url: e.request.url, start_ms: clock(), bytes: 0 });
  });
  cdp.on('Network.responseReceived', e => {
    const a = entries.get(e.requestId);
    if (a) Object.assign(a, { headers_ms: clock(), status: e.response.status, protocol: e.response.protocol, fromDiskCache: e.response.fromDiskCache, contentLength: e.response.headers['content-length'] ?? e.response.headers['Content-Length'] });
  });
  cdp.on('Network.dataReceived', e => {
    const a = entries.get(e.requestId);
    if (a) { a.bytes += e.dataLength; a.last_data_ms = clock(); }
  });
  cdp.on('Network.loadingFinished', e => {
    const a = entries.get(e.requestId);
    if (a) Object.assign(a, { finished_ms: clock(), encoded_bytes: e.encodedDataLength });
  });
  cdp.on('Network.loadingFailed', e => {
    const a = entries.get(e.requestId);
    if (a) Object.assign(a, { failed_ms: clock(), error: e.errorText });
  });
  if (mode === 'local-asset-control') {
    await page.route('**/assets/scenes/**/*.glb', async route => {
      const body = buffers.get(route.request().url());
      if (body) await route.fulfill({ status: 200, contentType: 'model/gltf-binary', headers: { 'access-control-allow-origin': '*' }, body });
      else await route.continue();
    });
  }
  const samples = [];
  let final = null;
  let error = null;
  try {
    await page.goto(`${base}/rooms/${scene.room}?debug=1`, { timeout: 30000, waitUntil: 'domcontentloaded' });
    while (clock() < 75000) {
      final = await page.evaluate(() => {
        const d = window.__VRATA_DEBUG__;
        const s = d?.sceneDebug;
        return d ? { sceneBundleState: d.sceneBundleState, state: s?.state, loadStage: s?.loadStage, failureReason: s?.failureReason, loadMs: s?.loadMs, assetBytesLoaded: s?.assetBytesLoaded, assetBytesExpected: s?.assetBytesExpected, meshCount: s?.meshCount } : null;
      });
      samples.push({ at_ms: clock(), state: final, requests: [...entries.values()].map(a => ({ ...a })) });
      if (final?.state === 'loaded' || final?.state === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (e) { error = e.message; }
  console.log(JSON.stringify({ kind: 'browser_sample', round, scene: scene.name, mode, elapsed_ms: clock(), error, final, samples, requests: [...entries.values()] }));
  await context.close();
}
try {
  for (const [round, mode] of ['network', 'network', 'local-asset-control', 'network', 'network'].entries()) {
    await Promise.all(scenes.map(scene => sample(scene, mode, round + 1)));
  }
} finally { await browser.close(); }
