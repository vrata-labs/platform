import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { sceneAssetIdentity, createSceneNetworkRecorder, captureSceneNetwork } from "./scene-network-diagnostics.mjs";

const url = "https://user:secret@example.test/assets/scenes/sense-hall2-v1/scene.glb?token=secret#secret";
function setup() {
  let now = 1000;
  const recorder = createSceneNetworkRecorder(() => now);
  const emit = (name, values = {}) => recorder.event(`Network.${name}`, { requestId: "1", timestamp: 10, ...values });
  emit("requestWillBeSent", { request: { url } });
  return { recorder, emit, row: () => recorder.snapshot().requests[0], advance: (ms) => { now += ms; } };
}

test("identity removes credentials/query/host and distinguishes assets", () => {
  const identity = sceneAssetIdentity(url);
  assert.equal(identity.scene, "Hall");
  assert.equal(identity.kind, "glb");
  assert.equal(identity.assetKey.length, 16);
  assert.deepEqual(identity, sceneAssetIdentity(url.replace("token=secret", "token=rotated")));
  assert.notEqual(identity.assetKey, sceneAssetIdentity(url.replace("scene.glb", "other.glb")).assetKey);
  assert.equal(JSON.stringify(identity).includes("secret"), false);
});

test("unrelated resources and unsupported schemes are ignored", () => {
  for (const input of ["bad", "file:///assets/scenes/x/scene.glb", "https://x/api/private.glb", "https://x/assets/scenes/x/texture.png"]) {
    assert.equal(sceneAssetIdentity(input), null);
  }
  assert.equal(sceneAssetIdentity("https://x/assets/scenes/x/scene.json").kind, "manifest");
});

test("partial transfer remains pending with exact bytes and relative times", () => {
  const { emit, row, advance } = setup();
  emit("responseReceived", { timestamp: 10.2, response: { status: 200, protocol: "h2", headers: { "Content-Length": "100" } } });
  emit("dataReceived", { timestamp: 11, dataLength: 40, encodedDataLength: 40 });
  advance(45000);
  assert.equal(row().state, "pending");
  assert.equal(row().headersMs, 200);
  assert.equal(row().firstDataMs, 1000);
  assert.equal(row().lastDataMs, 1000);
  assert.equal(row().bodyBytes, 40);
  assert.equal(row().expectedBodyBytes, 100);
  assert.equal(row().observedForMs, 45000);
  assert.equal(row().finishedMs, null);
});

test("completion keeps decoded, encoded body and encoded transfer sizes separate", () => {
  const { emit, row } = setup();
  emit("responseReceived", { response: { status: 200, headers: { "content-length": "30", "content-encoding": "gzip" } } });
  emit("dataReceived", { timestamp: 11, dataLength: 100, encodedDataLength: 30 });
  emit("loadingFinished", { timestamp: 12, encodedDataLength: 160 });
  assert.equal(row().state, "finished");
  assert.equal(row().bodyBytes, 100);
  assert.equal(row().encodedBodyBytes, 30);
  assert.equal(row().encodedTransferBytes, 160);
  assert.equal(row().compressed, true);
  assert.equal(row().finishedMs, 2000);
});

test("missing, malformed and unsafe content lengths remain unknown", () => {
  for (const value of [undefined, "", "-1", "4junk", "1.5", "9007199254740993"]) {
    const { emit, row } = setup();
    emit("responseReceived", { response: { headers: { "content-length": value } } });
    assert.equal(row().expectedBodyBytes, null);
  }
});

test("cached and service worker responses are explicit even without data events", () => {
  const { emit, row } = setup();
  emit("requestServedFromCache");
  emit("responseReceived", { response: { fromServiceWorker: true } });
  emit("loadingFinished", { encodedDataLength: 0 });
  assert.equal(row().fromCache, true);
  assert.equal(row().fromServiceWorker, true);
  assert.equal(row().state, "finished");
  assert.equal(row().bodyBytes, 0);
});

test("network failure preserves partial bytes but no arbitrary error text", () => {
  const { emit, row } = setup();
  emit("dataReceived", { dataLength: 4, encodedDataLength: 4 });
  emit("loadingFailed", { timestamp: 11, errorText: "https://private/?token=secret", canceled: true });
  assert.equal(row().state, "failed");
  assert.equal(row().bodyBytes, 4);
  assert.equal(row().errorCode, null);
  assert.equal(row().canceled, true);
});

test("Chromium error codes are retained", () => {
  const { emit, row } = setup();
  emit("loadingFailed", { errorText: "net::ERR_CONNECTION_RESET" });
  assert.equal(row().errorCode, "net::ERR_CONNECTION_RESET");
});

test("redirect out of asset paths cannot attribute unrelated data to old request", () => {
  const { recorder, emit, row } = setup();
  emit("requestWillBeSent", { timestamp: 11, request: { url: "https://x/login?secret=1" }, redirectResponse: {} });
  emit("dataReceived", { dataLength: 100 });
  assert.equal(row().state, "redirected");
  assert.equal(row().bodyBytes, 0);
  assert.equal(recorder.snapshot().requests.length, 1);
});

test("redirect to another asset produces two independent records", () => {
  const { recorder, emit } = setup();
  emit("requestWillBeSent", { timestamp: 11, request: { url: url.replace("scene.glb", "new.glb") }, redirectResponse: {} });
  emit("dataReceived", { timestamp: 12, dataLength: 10, encodedDataLength: 10 });
  const rows = recorder.snapshot().requests;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].state, "redirected");
  assert.equal(rows[1].bodyBytes, 10);
});

test("request and sample memory are bounded without losing final byte totals", () => {
  const { recorder, emit, row } = setup();
  for (let i = 0; i < 300; i++) emit("dataReceived", { timestamp: 11 + i, dataLength: 1, encodedDataLength: 1 });
  assert.equal(row().samples.length, 120);
  assert.equal(row().samples.at(-1).bodyBytes, 300);
  assert.equal(row().truncatedSamples, true);
  for (let i = 2; i <= 110; i++) emit("requestWillBeSent", { requestId: String(i), request: { url } });
  assert.equal(recorder.snapshot().requests.length, 100);
  assert.equal(recorder.snapshot().droppedRequests, 10);
});

test("runtime samples are allowlisted and freezes ignore teardown cancellations", () => {
  const { recorder, emit, advance } = setup();
  recorder.runtimeSample({ state: "fallback", loadStage: "asset_response_received", assetBytesLoaded: null, url, failureReason: "secret" });
  emit("dataReceived", { dataLength: 20, encodedDataLength: 20 });
  const snapshot = recorder.freeze();
  advance(1000);
  emit("loadingFailed", { errorText: "net::ERR_ABORTED" });
  recorder.runtimeSample({ state: "failed", loadStage: "secret" });
  assert.deepEqual(recorder.snapshot(), snapshot);
  assert.equal(snapshot.runtime.loadStage, "asset_response_received");
  assert.equal(JSON.stringify(snapshot).includes("secret"), false);
});

test("each recorder isolates identical request IDs and unknown events", () => {
  const a = setup(), b = setup();
  a.emit("dataReceived", { dataLength: 15 });
  a.emit("dataReceived", { requestId: "unknown", dataLength: 999 });
  assert.equal(a.row().bodyBytes, 15);
  assert.equal(b.row().bodyBytes, 0);
});

test("adapter only enables passive Network observation and cleans listeners", async () => {
  const session = new EventEmitter();
  const commands = [];
  session.send = async (command) => { commands.push(command); };
  session.detach = async () => { commands.push("detach"); };
  const page = new EventEmitter();
  page.context = () => ({ newCDPSession: async () => session });
  page.evaluate = async () => ({ state: "fallback" });
  const capture = await captureSceneNetwork(page);
  session.emit("Network.requestWillBeSent", { requestId: "1", timestamp: 1, request: { url } });
  session.emit("Network.dataReceived", { requestId: "1", timestamp: 2, dataLength: 16, encodedDataLength: 16 });
  assert.equal(capture.snapshot().requests[0].bodyBytes, 16);
  capture.stop();
  capture.stop();
  assert.deepEqual(commands, ["Network.enable", "detach"]);
  assert.equal(page.listenerCount("close"), 0);
  assert.equal(session.eventNames().length, 0);
});

test("unsupported CDP is explicit and original exception text is not retained", async () => {
  const page = new EventEmitter();
  page.context = () => ({ newCDPSession: async () => { throw new Error("secret"); } });
  const capture = await captureSceneNetwork(page);
  assert.equal(capture.snapshot().availability, "cdp_unavailable");
  assert.equal(JSON.stringify(capture.snapshot()).includes("secret"), false);
  capture.stop();
});
