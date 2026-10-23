import assert from "node:assert/strict";
import test from "node:test";
import { IdentityStorageError } from "../identity/contracts.js";
import { RoomFenceCommitUncertain, RoomFenceUnavailable } from "../identity/fence-transaction.js";
import { RoomPluginAccessError, type RoomPluginUploadTicket } from "./access-contracts.js";
import { RoomPluginBlobIoError } from "./blob-errors.js";
import { RoomPluginBlobWriteUncertain } from "./blob-storage.js";
import { RoomPluginStorageError } from "./contracts.js";
import { pluginHttpFixture } from "./http-test-helper.js";
import { createRoomPluginHttpPackageService, RoomPluginHttpOperationPending } from "./package-http-service.js";

function databaseError(code: string): Error & { code: string } {
  return Object.assign(new Error("injected database transport failure"), { code });
}
function trackTerminalSettlement(f: ReturnType<typeof pluginHttpFixture>, outcome: "acked" | "rejected",
  operation: typeof f.access.continuation.settleUpload): void {
  const reserve = f.author.reservePackage;
  let originalTicket: RoomPluginUploadTicket | undefined;
  f.author.reservePackage = async (...args) => { originalTicket = await reserve(...args); return originalTicket; };
  f.access.continuation.settleUpload = async (ticket, actualOutcome) => {
    assert.strictEqual(ticket, originalTicket, "each settlement attempt must use the original opaque ticket");
    assert.equal(actualOutcome, outcome, "a terminal writer outcome must never change between attempts");
    return operation(ticket, actualOutcome);
  };
}

test("author admission precedes SDK validation and credential resolution", async () => {
  for (const error of [new RoomPluginAccessError("plugin_author_forbidden"), new IdentityStorageError("identity_session_expired")]) {
    const f = pluginHttpFixture(); f.setDenial(error);
    await assert.rejects(createRoomPluginHttpPackageService(f.access, f.deps.getBlobs).savePackage(f.author, Uint8Array.of(255)), e => e === error);
    assert.deepEqual(f.calls, ["authorize"]);
  }
  const f = pluginHttpFixture();
  await assert.rejects(createRoomPluginHttpPackageService(f.access, f.deps.getBlobs).savePackage(f.author, Uint8Array.of(255)), { code: "invalid_utf8" });
  assert.deepEqual(f.calls, ["authorize"]);
});

test("immutable upload records its known acknowledgement before fenced publication", async () => {
  const f = pluginHttpFixture();
  const bytes = await createRoomPluginHttpPackageService(f.access, f.deps.getBlobs).savePackage(f.author, f.bytes);
  assert.equal(bytes.state, "ready"); assert.equal(bytes.uploadSettled, true);
  assert.deepEqual(f.calls, ["authorize", "config", "reserve", "put", "settle-acked", "publish"]);
  assert.deepEqual(f.objects.get(f.value.storageKey), f.bytes);
  assert.equal((globalThis as Record<string, unknown>).__plugin_http_executed, undefined);
});

test("unknown writers retain the reservation and never enter settlement retry even with retryable transport causes", async () => {
  for (const failure of [new RoomPluginBlobWriteUncertain(databaseError("ECONNRESET")), new Error("unclassified interrupted writer"),
    databaseError("55P03"), new RoomFenceUnavailable(databaseError("ECONNREFUSED"))]) {
    const f = pluginHttpFixture();
    f.blobs.put = async (_scope, key, bytes) => { f.calls.push("put"); f.objects.set(key, bytes); throw failure; };
    await assert.rejects(createRoomPluginHttpPackageService(f.access, f.deps.getBlobs).savePackage(f.author, f.bytes), RoomPluginHttpOperationPending);
    assert.equal(f.value.state, "reserved"); assert.equal(f.value.uploadSettled, false); assert.equal(f.objects.size, 1);
    assert.deepEqual(f.calls, ["authorize", "config", "reserve", "put"]);
  }
});

test("terminal ACK settlement retries transient lock/pool/pre-COMMIT failures, then freshly publishes without another PUT", async () => {
  const failures = [
    [databaseError("55P03"), new RoomFenceUnavailable(databaseError("ECONNREFUSED"))],
    [databaseError("ECONNRESET")]
  ];
  for (const transient of failures) {
    const f = pluginHttpFixture(), settle = f.access.continuation.settleUpload;
    let attempts = 0;
    trackTerminalSettlement(f, "acked", async (ticket, outcome) => {
      f.calls.push("settle-attempt");
      const failure = transient[attempts++];
      if (failure) throw failure;
      return settle(ticket, outcome);
    });
    const result = await createRoomPluginHttpPackageService(f.access, f.deps.getBlobs).savePackage(f.author, f.bytes);
    assert.equal(attempts, transient.length + 1); assert.equal(result.state, "ready"); assert.equal(result.uploadSettled, true);
    assert.equal(f.calls.filter(call => call === "put").length, 1);
    assert.equal(f.calls.filter(call => call === "reserve").length, 1);
    assert.deepEqual(f.calls.slice(-2), ["settle-acked", "publish"]);
    assert.equal(f.calls.includes("read"), false); assert.equal(f.calls.includes("delete"), false);
    assert.deepEqual(f.objects.get(f.value.storageKey), f.bytes);
  }
});

test("lost settlement COMMIT acknowledgements replay the original ACK idempotently and preserve concurrent ready publication", async () => {
  const f = pluginHttpFixture(), settle = f.access.continuation.settleUpload;
  let attempts = 0;
  trackTerminalSettlement(f, "acked", async (ticket, outcome) => {
    attempts++;
    const result = await settle(ticket, outcome);
    if (attempts === 1) f.value.state = "ready";
    if (attempts < 3) throw new RoomFenceCommitUncertain(databaseError("ECONNRESET"));
    assert.equal(result, null); return result;
  });
  const result = await createRoomPluginHttpPackageService(f.access, f.deps.getBlobs).savePackage(f.author, f.bytes);
  assert.equal(attempts, 3); assert.equal(result.state, "ready"); assert.equal(f.value.uploadSettled, true);
  assert.deepEqual(f.calls, ["authorize", "config", "reserve", "put", "settle-acked", "settle-acked", "settle-acked", "publish"]);
  assert.equal(f.calls.includes("abandon"), false); assert.equal(f.calls.includes("delete"), false);
  assert.deepEqual(f.objects.get(f.value.storageKey), f.bytes);
});

test("proven rejected PUT settlement retries before cleanup and only deletes after a confirmed cleanup intent", async () => {
  const f = pluginHttpFixture(), settle = f.access.continuation.settleUpload, remove = f.blobs.delete;
  const rejection = new RoomPluginBlobIoError("put", new Error("confirmed terminal PUT rejection"));
  let attempts = 0;
  f.blobs.put = async (_scope, key, bytes) => { f.calls.push("put"); f.objects.set(key, bytes); throw rejection; };
  trackTerminalSettlement(f, "rejected", async (ticket, outcome) => {
    f.calls.push("settle-attempt");
    if (++attempts === 1) throw new RoomFenceUnavailable(databaseError("ECONNRESET"));
    return settle(ticket, outcome);
  });
  f.blobs.delete = async (...args) => {
    assert.equal(attempts, 2); assert.equal(f.value.state, "cleanup-pending"); assert.equal(f.value.uploadSettled, true);
    await remove(...args);
  };
  await assert.rejects(createRoomPluginHttpPackageService(f.access, f.deps.getBlobs).savePackage(f.author, f.bytes), e => e === rejection);
  assert.deepEqual(f.calls, ["authorize", "config", "reserve", "put", "settle-attempt", "settle-attempt", "settle-rejected", "delete", "confirm-delete"]);
  assert.equal(f.value.state, "deleted"); assert.equal(f.objects.size, 0); assert.equal(f.calls.includes("publish"), false);
});

test("terminal settlement retry exhaustion retains the indexed blob and never publishes or deletes", async () => {
  for (const outcome of ["acked", "rejected"] as const) {
    const f = pluginHttpFixture(), terminalRejection = new RoomPluginBlobIoError("put", new Error("confirmed rejection"));
    const unavailable = new RoomFenceUnavailable(databaseError("ECONNREFUSED"));
    if (outcome === "rejected") f.blobs.put = async (_scope, key, bytes) => { f.calls.push("put"); f.objects.set(key, bytes); throw terminalRejection; };
    let attempts = 0;
    trackTerminalSettlement(f, outcome, async () => { attempts++; f.calls.push("settle-attempt"); throw unavailable; });
    await assert.rejects(createRoomPluginHttpPackageService(f.access, f.deps.getBlobs).savePackage(f.author, f.bytes),
      e => e instanceof RoomPluginHttpOperationPending && (outcome === "acked" ? e.cause === unavailable
        : e.cause === terminalRejection && e.cleanupCause === unavailable));
    assert.equal(attempts, 3); assert.equal(f.value.state, "reserved"); assert.equal(f.value.uploadSettled, false);
    assert.equal(f.calls.filter(call => call === "put").length, 1);
    assert.equal(f.calls.filter(call => call === "reserve").length, 1);
    assert.deepEqual(f.objects.get(f.value.storageKey), f.bytes);
    for (const forbidden of ["publish", "abandon", "delete", "confirm-delete", "read"]) assert.equal(f.calls.includes(forbidden), false);
  }
});

test("invalid tickets, storage/not-found errors and unclassified failures do not retry terminal settlement", async () => {
  const failures = [new RoomPluginAccessError("plugin_ticket_invalid"), new RoomPluginStorageError("room_not_found"),
    new RoomPluginStorageError("plugin_package_not_found"), new RoomPluginStorageError("plugin_invalid_transition"), new Error("unclassified defect")];
  for (const outcome of ["acked", "rejected"] as const) for (const failure of failures) {
    const f = pluginHttpFixture(), rejection = new RoomPluginBlobIoError("put", new Error("confirmed rejection"));
    if (outcome === "rejected") f.blobs.put = async (_scope, key, bytes) => { f.calls.push("put"); f.objects.set(key, bytes); throw rejection; };
    let attempts = 0;
    trackTerminalSettlement(f, outcome, async () => { attempts++; throw failure; });
    await assert.rejects(createRoomPluginHttpPackageService(f.access, f.deps.getBlobs).savePackage(f.author, f.bytes),
      e => e instanceof RoomPluginHttpOperationPending && (outcome === "acked" ? e.cause === failure : e.cause === rejection && e.cleanupCause === failure));
    assert.equal(attempts, 1); assert.equal(f.value.state, "reserved"); assert.equal(f.value.uploadSettled, false);
    assert.deepEqual(f.objects.get(f.value.storageKey), f.bytes);
    assert.equal(f.calls.includes("publish"), false); assert.equal(f.calls.includes("delete"), false);
  }
});

test("recovered settlement still uses the fresh publication guard after authority is lost during backoff", async () => {
  const f = pluginHttpFixture(), settle = f.access.continuation.settleUpload;
  const denial = new RoomPluginAccessError("plugin_author_forbidden");
  let attempts = 0;
  trackTerminalSettlement(f, "acked", async (ticket, outcome) => {
    f.calls.push("settle-attempt");
    if (++attempts === 1) { f.setDenial(denial); throw databaseError("55P03"); }
    return settle(ticket, outcome);
  });
  await assert.rejects(createRoomPluginHttpPackageService(f.access, f.deps.getBlobs).savePackage(f.author, f.bytes), e => e === denial);
  assert.equal(attempts, 2);
  assert.deepEqual(f.calls, ["authorize", "config", "reserve", "put", "settle-attempt", "settle-attempt", "settle-acked", "publish", "abandon", "delete", "confirm-delete"]);
  assert.equal(f.value.state, "deleted"); assert.equal(f.objects.size, 0);
});

test("known PUT ACK followed by confirmed author denial cleans only the admitted unpublished ticket", async () => {
  const f = pluginHttpFixture(), denial = new RoomPluginAccessError("plugin_author_forbidden");
  const put = f.blobs.put;
  f.blobs.put = async (...args) => { await put(...args); f.setDenial(denial); };
  await assert.rejects(createRoomPluginHttpPackageService(f.access, f.deps.getBlobs).savePackage(f.author, f.bytes), e => e === denial);
  assert.deepEqual(f.calls, ["authorize", "config", "reserve", "put", "settle-acked", "publish", "abandon", "delete", "confirm-delete"]);
  assert.equal(f.value.state, "deleted"); assert.equal(f.objects.size, 0);
});

test("room deletion admitted after upload settlement cleans the confirmed unpublished reservation", async () => {
  const f = pluginHttpFixture(), failure = new RoomPluginStorageError("room_plugin_cleanup_pending");
  const settle = f.access.continuation.settleUpload;
  let deleting = false;
  f.access.continuation.settleUpload = async (...args) => {
    const result = await settle(...args);
    assert.equal(f.value.state, "reserved"); assert.equal(f.value.uploadSettled, true);
    f.calls.push("room-delete-intent"); deleting = true;
    return result;
  };
  f.author.publishPackage = async () => {
    f.calls.push("publish"); assert.equal(deleting, true);
    assert.equal(f.value.state, "reserved"); assert.equal(f.value.uploadSettled, true);
    throw failure;
  };
  await assert.rejects(createRoomPluginHttpPackageService(f.access, f.deps.getBlobs).savePackage(f.author, f.bytes), e => e === failure);
  assert.deepEqual(f.calls, ["authorize", "config", "reserve", "put", "settle-acked", "room-delete-intent", "publish", "abandon", "delete", "confirm-delete"]);
  assert.equal(f.value.state, "deleted"); assert.equal(f.value.uploadSettled, true); assert.equal(f.objects.size, 0);
});

test("confirmed room-deletion publication denial never deletes a concurrent publisher's ready package", async () => {
  const f = pluginHttpFixture(), failure = new RoomPluginStorageError("room_plugin_cleanup_pending");
  f.author.publishPackage = async () => {
    f.calls.push("publish"); assert.equal(f.value.uploadSettled, true);
    f.value.state = "ready";
    throw failure;
  };
  const abandon = f.access.continuation.abandonUnpublished;
  f.access.continuation.abandonUnpublished = async ticket => {
    const result = await abandon(ticket); assert.equal(result, null); return result;
  };
  await assert.rejects(createRoomPluginHttpPackageService(f.access, f.deps.getBlobs).savePackage(f.author, f.bytes), e => e === failure);
  assert.deepEqual(f.calls, ["authorize", "config", "reserve", "put", "settle-acked", "publish", "abandon"]);
  assert.equal(f.value.state, "ready"); assert.deepEqual(f.objects.get(f.value.storageKey), f.bytes);
  assert.equal(f.calls.includes("delete"), false); assert.equal(f.calls.includes("confirm-delete"), false);
});

test("uncertain publication commits with cleanup-pending causes never abandon, including nested outer denial", async () => {
  const outerDenial = new RoomPluginStorageError("room_plugin_cleanup_pending");
  outerDenial.cause = new Error("nested commit failure", {
    cause: new RoomFenceCommitUncertain(new RoomPluginStorageError("room_plugin_cleanup_pending"))
  });
  const failures = [
    new RoomFenceCommitUncertain(new RoomPluginStorageError("room_plugin_cleanup_pending")),
    new Error("wrapped publication failure", { cause: new RoomFenceCommitUncertain(new RoomPluginStorageError("room_plugin_cleanup_pending")) }),
    outerDenial
  ];
  for (const failure of failures) {
    const f = pluginHttpFixture();
    f.author.publishPackage = async () => { f.calls.push("publish"); throw failure; };
    await assert.rejects(createRoomPluginHttpPackageService(f.access, f.deps.getBlobs).savePackage(f.author, f.bytes),
      e => e instanceof RoomPluginHttpOperationPending && e.cause === failure);
    assert.deepEqual(f.calls, ["authorize", "config", "reserve", "put", "settle-acked", "publish"]);
    assert.equal(f.value.state, "reserved"); assert.equal(f.value.uploadSettled, true);
    assert.deepEqual(f.objects.get(f.value.storageKey), f.bytes);
    assert.equal(f.calls.includes("abandon"), false); assert.equal(f.calls.includes("delete"), false);
  }
});

test("a lost publish COMMIT cannot be compensated, including an auth-looking outer failure", async () => {
  const f = pluginHttpFixture();
  const failure = new RoomFenceCommitUncertain(new IdentityStorageError("identity_forbidden"));
  f.author.publishPackage = async () => { f.calls.push("publish"); f.value.state = "ready"; throw failure; };
  await assert.rejects(createRoomPluginHttpPackageService(f.access, f.deps.getBlobs).savePackage(f.author, f.bytes),
    e => e instanceof RoomPluginHttpOperationPending && e.cause === failure);
  assert.equal(f.objects.size, 1); assert.equal(f.value.state, "ready");
  assert.equal(f.calls.includes("abandon"), false); assert.equal(f.calls.includes("delete"), false);
});

test("cleanup failure retains intent and the original denial without exposing private metadata", async () => {
  const f = pluginHttpFixture(), denial = new IdentityStorageError("identity_session_expired"), failedDelete = new Error("private key secret");
  f.author.publishPackage = async () => { throw denial; };
  f.blobs.delete = async () => { f.calls.push("delete"); throw failedDelete; };
  await assert.rejects(createRoomPluginHttpPackageService(f.access, f.deps.getBlobs).savePackage(f.author, f.bytes),
    e => e instanceof RoomPluginHttpOperationPending && e.cause === denial && e.cleanupCause === failedDelete);
  assert.equal(f.value.state, "cleanup-pending"); assert.equal(f.value.uploadSettled, true);
  assert.equal(f.objects.size, 1); assert.equal(f.calls.includes("confirm-delete"), false);
});

test("concurrent ready publisher denies abandonment and known rejection never triggers an unsafe DELETE", async () => {
  for (const phase of ["reject", "publish"]) {
    const f = pluginHttpFixture();
    if (phase === "reject") f.blobs.put = async (_scope, key, bytes) => {
      f.calls.push("put"); f.objects.set(key, bytes); f.value.state = "ready"; f.value.uploadSettled = true;
      throw new RoomPluginBlobIoError("put", new Error("known rejected PUT"));
    };
    else f.author.publishPackage = async () => {
      f.value.state = "ready"; throw new RoomPluginAccessError("plugin_author_forbidden");
    };
    await assert.rejects(createRoomPluginHttpPackageService(f.access, f.deps.getBlobs).savePackage(f.author, f.bytes));
    assert.equal(f.objects.size, 1); assert.equal(f.value.state, "ready");
    assert.equal(f.calls.includes("delete"), false); assert.equal(f.calls.includes("confirm-delete"), false);
  }
});

test("only durable settled reserved uploads may resume; validate the stored blob, never issue a second PUT", async () => {
  const f = pluginHttpFixture(); f.value.uploadSettled = true; f.objects.set(f.value.storageKey, f.bytes);
  await createRoomPluginHttpPackageService(f.access, f.deps.getBlobs).savePackage(f.author, f.bytes);
  assert.deepEqual(f.calls, ["authorize", "config", "reserve", "read", "publish"]);
  const bad = pluginHttpFixture(); bad.value.uploadSettled = true; bad.objects.set(bad.value.storageKey, Uint8Array.of(255));
  await assert.rejects(createRoomPluginHttpPackageService(bad.access, bad.deps.getBlobs).savePackage(bad.author, bad.bytes));
  assert.equal(bad.calls.includes("publish"), false); assert.equal(bad.calls.includes("put"), false); assert.equal(bad.calls.includes("delete"), false);
  const unknown = pluginHttpFixture(); unknown.author.reservePackage = async () => unknown.ticket("resume");
  await assert.rejects(createRoomPluginHttpPackageService(unknown.access, unknown.deps.getBlobs).savePackage(unknown.author, unknown.bytes),
    e => e instanceof RoomPluginStorageError && e.code === "plugin_upload_pending");
  assert.equal(unknown.calls.includes("read"), false); assert.equal(unknown.calls.includes("put"), false);
});

test("known rejected PUT cleanup is a continuation, independent of subsequent role loss", async () => {
  const f = pluginHttpFixture(), failure = new RoomPluginBlobIoError("put", new Error("known rejection"));
  f.blobs.put = async () => { f.calls.push("put"); f.setDenial(new RoomPluginAccessError("plugin_author_forbidden")); throw failure; };
  await assert.rejects(createRoomPluginHttpPackageService(f.access, f.deps.getBlobs).savePackage(f.author, f.bytes), e => e === failure);
  assert.equal(f.value.state, "deleted");
  assert.deepEqual(f.calls, ["authorize", "config", "reserve", "put", "settle-rejected", "delete", "confirm-delete"]);
});

test("admitted deletion finishes through trusted cleanup after role loss, and locator drift refuses IO", async () => {
  const f = pluginHttpFixture(); f.value.state = "ready"; f.value.uploadSettled = true; f.objects.set(f.value.storageKey, f.bytes);
  const begin = f.author.beginPackageDeletion;
  f.author.beginPackageDeletion = async (...args) => { const result = await begin(...args); f.setDenial(new RoomPluginAccessError("plugin_author_forbidden")); return result; };
  await createRoomPluginHttpPackageService(f.access, f.deps.getBlobs).deletePackage(f.author, f.value.packageId);
  assert.deepEqual(f.calls, ["authorize", "delete-intent", "config", "delete", "confirm-delete"]);
  const bad = pluginHttpFixture(); bad.value.uploadSettled = true; bad.value.backendFingerprint = "b".repeat(64);
  await assert.rejects(createRoomPluginHttpPackageService(bad.access, bad.deps.getBlobs).deletePackage(bad.author, bad.value.packageId), RoomPluginHttpOperationPending);
  assert.equal(bad.value.state, "cleanup-pending"); assert.equal(bad.calls.includes("delete"), false);
});

test("uncertain reservation is not retried; exhausted settlement retries preserve metadata and bytes", async () => {
  const failure = new RoomFenceCommitUncertain(new Error("commit result unavailable"));
  const reserve = pluginHttpFixture();
  reserve.author.reservePackage = async () => { reserve.calls.push("reserve"); throw failure; };
  await assert.rejects(createRoomPluginHttpPackageService(reserve.access, reserve.deps.getBlobs).savePackage(reserve.author, reserve.bytes), e => e === failure);
  assert.equal(reserve.calls.includes("put"), false); assert.equal(reserve.calls.includes("delete"), false);
  assert.equal(reserve.calls.filter(call => call === "reserve").length, 1);
  const settle = pluginHttpFixture();
  settle.access.continuation.settleUpload = async () => { settle.calls.push("settle-acked"); settle.value.uploadSettled = true; throw failure; };
  await assert.rejects(createRoomPluginHttpPackageService(settle.access, settle.deps.getBlobs).savePackage(settle.author, settle.bytes),
    e => e instanceof RoomPluginHttpOperationPending && e.cause === failure);
  assert.equal(settle.objects.size, 1); assert.equal(settle.calls.includes("publish"), false);
  assert.equal(settle.calls.filter(call => call === "settle-acked").length, 3);
  assert.equal(settle.calls.filter(call => call === "put").length, 1);
  assert.equal(settle.calls.includes("delete"), false); assert.equal(settle.calls.includes("abandon"), false);
});

test("a ready retry uses no object IO, and a malformed cleanup ticket cannot authorize DELETE", async () => {
  const ready = pluginHttpFixture(); ready.value.state = "ready"; ready.value.uploadSettled = true;
  const result = await createRoomPluginHttpPackageService(ready.access, ready.deps.getBlobs).savePackage(ready.author, ready.bytes);
  assert.equal(result.state, "ready"); assert.deepEqual(ready.calls, ["authorize", "config", "reserve"]);
  const invalid = pluginHttpFixture();
  invalid.author.publishPackage = async () => { throw new RoomPluginAccessError("plugin_author_forbidden"); };
  invalid.access.continuation.abandonUnpublished = async () => { invalid.value.state = "ready"; return invalid.deletion(); };
  await assert.rejects(createRoomPluginHttpPackageService(invalid.access, invalid.deps.getBlobs).savePackage(invalid.author, invalid.bytes), RoomPluginHttpOperationPending);
  assert.equal(invalid.value.state, "ready"); assert.equal(invalid.objects.size, 1);
  assert.equal(invalid.calls.includes("delete"), false); assert.equal(invalid.calls.includes("confirm-delete"), false);
});
