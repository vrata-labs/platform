import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(new URL("../../../apps/api/package.json", import.meta.url));
const apiHeaders = { "content-type": "application/json", "x-vrata-admin-token": "local-fixture-admin" };

async function eventually(check, description, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() >= deadline) throw new Error(description);
    await delay(120);
  }
}

async function createRoom(api, enable) {
  const created = await fetch(`${api}/api/rooms`, {
    method: "POST", headers: apiHeaders, body: JSON.stringify({
      tenantId: "demo-tenant", templateId: "meeting-room-basic", name: `Synthetic room ${randomBytes(4).toString("hex")}`, visibility: "private"
    })
  });
  assert.equal(created.status, 201, "create fixture room");
  const { roomId } = await created.json();
  if (enable) await updateRule(api, roomId, "public-https");
  return roomId;
}

async function updateRule(api, roomId, remoteBrowserUrlPolicy) {
  const response = await fetch(`${api}/api/rooms/${roomId}`, {
    method: "PATCH", headers: apiHeaders, body: JSON.stringify({ remoteBrowserUrlPolicy })
  });
  assert.equal(response.status, 200, "update fixture URL rule");
}

async function roomHost(stateBase, roomId, marker) {
  const socket = new WebSocket(`${stateBase}?roomId=${roomId}&participantId=fixture-host&role=host`);
  const replies = new Map();
  let snapshot, objectId, leaked = false;
  socket.addEventListener("message", event => {
    leaked ||= event.data.includes(marker);
    const message = JSON.parse(event.data);
    if (message.room) snapshot = message.room;
    if (message.result?.commandId) replies.set(message.result.commandId, message.result);
  });
  async function command(body, eventId = randomUUID()) {
    socket.send(JSON.stringify({ ...body, commandId: eventId, surfaceId: "debug-main" }));
    const result = await eventually(() => replies.get(eventId), `room-state did not answer ${body.type}`);
    assert.equal(result.accepted, true, `room-state denied ${body.type}: ${result.blockedReason}`);
    return result;
  }
  const object = () => snapshot?.mediaObjects?.objects?.[objectId];
  async function patch(body) {
    const inputEventId = randomUUID();
    return command({
      type: "surface_patch_object_state", objectId, expectedRevision: object().revision,
      patch: { ...body, inputEventId }
    }, inputEventId);
  }
  try {
    await eventually(() => snapshot, "host did not join fixture room");
    ({ objectId } = await command({ type: "surface_create_object", objectType: "remote-browser", probeOnly: false }));
    await eventually(object, "room-state did not publish browser object");
  } catch (error) {
    socket.close();
    throw error;
  }
  return {
    state: () => object()?.state,
    open: url => patch({ type: "open-url", url }),
    click: u => patch({ type: "pointer", event: { eventId: randomUUID(), surfaceId: "debug-main", kind: "click", source: "desktop", uv: { u, v: 0.5 } } }),
    stop: () => command({ type: "surface_stop_object", objectId, expectedRevision: object().revision }),
    close: () => socket.close(),
    leaked: () => leaked
  };
}

const expectedRgb = { red: [255, 0, 0], purple: [128, 0, 128], blue: [0, 0, 255], lime: [0, 255, 0], yellow: [255, 255, 0] };
const matches = (color, pixel) => expectedRgb[color].every((value, index) => Math.abs(value - pixel[index]) < 30);

export async function runMedia({ compose, processPeer, observations }) {
  const { AccessToken } = require("livekit-server-sdk");
  const marker = `fixture-url-${randomBytes(14).toString("hex")}`;
  const started = ["fixture-api", "fixture-room-state", "fixture-executor", "fixture-livekit", "fixture-receiver",
    "public-https-chromium", "public-https-chromium-92"];
  const hosts = [];
  let receiver;
  try {
    compose("up", "-d", ...started);
    const api = `http://${compose("port", "fixture-api", "4000")}`;
    const state = `ws://${compose("port", "fixture-room-state", "2567")}`;
    await eventually(() => fetch(`${api}/health`).then(response => response.ok).catch(() => false), "fixture API unavailable");
    const ids = await Promise.all([createRoom(api, true), createRoom(api, true), createRoom(api, false)]);
    hosts.push(...await Promise.all(ids.map(id => roomHost(state, id, marker))));
    const [alpha, beta, legacy] = hosts;
    const tokens = await Promise.all(ids.slice(0, 2).map(id => {
      const token = new AccessToken("devkey", "fixture-media-signing-key-only-for-local-tests", { identity: `observer-${id}`, ttl: 120 });
      token.addGrant({ room: `vrata-${id}`, roomJoin: true, canPublish: false, canPublishData: false, canSubscribe: true });
      return token.toJwt();
    }));
    receiver = processPeer("exec", "-T", "fixture-receiver", "sh", "-c",
      "exec /opt/vrata-publisher/bin/python /fixture/receive.py 2>/dev/null");
    receiver.send(JSON.stringify(tokens));
    assert.deepEqual(await receiver.next(), { ready: true });
    const reports = async () => { receiver.send("observations"); return receiver.next(); };
    const sample = (index, identity, color, frequency) => eventually(async () => {
      const report = (await reports())[index];
      assert.ok(report.participants.every(participant => participant === identity), "unexpected publisher in subscriber room");
      const data = report.samples[identity];
      if (data && Math.abs(data.frequency - frequency) <= 25
        && data.pixels.some(pixel => matches(color, pixel[0]) && matches("lime", pixel[1]))
        && data.pixels.some(pixel => matches(color, pixel[0]) && matches("yellow", pixel[1]))) return data.frequency;
    }, `subscriber did not observe changing ${color} frames and the ${frequency} Hz tone`);
    const waitState = async (host, predicate, label) => {
      try {
        return await eventually(() => {
          const state = host.state();
          return state && predicate(state) && state;
        }, label);
      } catch (error) {
        throw new Error(`${label}; last browser state: ${host.state()?.status}/${host.state()?.errorCode}`, { cause: error });
      }
    };
    const open = (host, url) => host.open(`${url}?customProbe=${marker}`);

    await open(alpha, "http://channel.test/plaintext");
    await waitState(alpha, value => value.errorCode === "url_not_allowed", "initial scheme refusal");
    await open(alpha, "https://denied.test/hidden");
    await waitState(alpha, value => value.errorCode === "url_resolution_blocked", "initial private destination");
    await open(alpha, "https://badcert.test/document");
    await waitState(alpha, value => value.errorCode === "navigation_failed", "initial unavailable site");
    await Promise.all([open(alpha, "https://allowed.test/media-red"), open(beta, "https://allowed.test/media-purple")]);
    const a = await waitState(alpha, value => value.status === "active", "first real publication");
    const b = await waitState(beta, value => value.status === "active", "second real publication");
    await eventually(() => observations("allowed").filter(event => event.path === "/page-without-authority").length >= 2,
      "pages did not confirm the absence of publishing state and microphone permission");
    assert.ok(!observations("allowed").some(event => event.path === "/page-has-authority"));
    const red = await sample(0, a.mediaParticipantId, "red", 440);
    const purple = await sample(1, b.mediaParticipantId, "purple", 660);
    await alpha.click(0.85);
    await waitState(alpha, value => value.resourceIssue === "private_destination" && value.status === "active",
      "a resource denial must not stop streaming");
    await sample(0, a.mediaParticipantId, "red", 440);
    await alpha.click(0.5);
    await waitState(alpha, value => !value.resourceIssue, "successful navigation must clear the previous resource issue");
    const blue = await sample(0, a.mediaParticipantId, "blue", 880);
    assert.equal(alpha.state().mediaTrackSid, a.mediaTrackSid);
    assert.equal(alpha.state().audioTrackSid, a.audioTrackSid);
    await sample(1, b.mediaParticipantId, "purple", 660);
    await alpha.click(0.1);
    await waitState(alpha, value => value.navigationIssue === "private_destination" && value.status === "active", "later navigation refusal");
    await open(alpha, "https://allowed.test/media-red");
    const retry = await waitState(alpha, value => value.status === "active" && !value.navigationIssue, "explicit retry after later navigation refusal");
    await sample(0, retry.mediaParticipantId, "red", 440);

    const revokeAt = Date.now();
    await updateRule(api, ids[0], "allowlist");
    const removed = async index => !(await reports())[index].participants.length;
    const revoked = await eventually(async () => await removed(0) && Date.now() - revokeAt, "publisher survived room rule withdrawal", 10_000);
    assert.ok(revoked <= 10_000);
    const networkRevoked = await eventually(() => {
      const event = observations("allowed").findLast(event => event.event === "stream-closed" && event.path === "/hold/red" && event.time >= revokeAt);
      return event && event.time - revokeAt;
    }, "network survived room rule withdrawal");
    assert.ok(networkRevoked <= 10_000);
    await sample(1, b.mediaParticipantId, "purple", 660);

    // Suspend only the executor (not the publisher, gateway or Chromium).
    const signalExecutor = signal => compose("exec", "-T", "fixture-executor", "sh", "-c",
      `pid=$(pgrep -f '^node apps/remote-browser/dist/index.js$') && kill -${signal} "$pid" && date +%s%3N`);
    const expiredAt = Number(signalExecutor("STOP"));
    assert.ok(Number.isSafeInteger(expiredAt) && expiredAt > 0);
    let expired, networkExpired;
    try {
      expired = await eventually(async () => await removed(1) && Date.now() - expiredAt, "publisher survived an undelivered renewal", 10_500);
      networkExpired = await eventually(() => {
        const event = observations("allowed").findLast(event => event.event === "stream-closed" && event.path === "/hold/purple" && event.time >= expiredAt);
        return event && event.time - expiredAt;
      }, "gateway survived an undelivered renewal", 1_000);
    } finally {
      signalExecutor("CONT");
    }
    assert.ok(expired <= 10_000 && networkExpired <= 10_000, "grant lasted beyond 10 seconds");
    await waitState(beta, value => value.status === "failed", "expired executor state");

    const slotClean = () => ["public-https-chromium", "public-https-chromium-92"].every(service =>
      compose("exec", "-T", service, "sh", "-c", "ls -A /tmp/.X11-unix").trim() === "worker.ready\nworker.sock");
    await eventually(slotClean, "expired capture files still exist");

    await receiver.close();
    receiver = undefined;
    compose("stop", "-t", "1", "fixture-livekit");
    await open(beta, "https://allowed.test/media-purple");
    await waitState(beta, value => value.status === "failed", "failed publisher startup");
    await eventually(slotClean, "failed startup left capture files");
    compose("up", "-d", "fixture-livekit");

    await open(legacy, "https://allowed.test/media-red");
    await waitState(legacy, value => value.errorCode === "url_not_allowed", "old room still blocks out-of-list destinations");
    await open(legacy, "http://127.0.0.1:4010/internal/viewport-publisher");
    await waitState(legacy, value => value.status === "active", "old room still opens listed addresses");
    await legacy.click(0.1);
    await waitState(legacy, value => value.lastExecutorInput?.status === "applied", "old path still applies input");
    assert.ok(hosts.every(host => !host.leaked()), "URL parameters reached a room-state snapshot");
    assert.ok(!compose("logs", "--no-color").includes(marker), "URL parameters reached the diagnostic logs");
    console.log(JSON.stringify({ capturedTonesHz: [red, blue, purple], revokeMs: revoked, networkRevokeMs: networkRevoked, networkExpiryMs: networkExpired,
      publicationExpiryMs: expired, failedStartupClean: true, markerLeaked: false }));
  } finally {
    for (const host of hosts) host.close();
    await receiver?.close().catch(() => {});
  }
}
