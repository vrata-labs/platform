import assert from "node:assert/strict";
import test from "node:test";
import { assertIdentityRollbackTarget, OWNERLESS_REFERENCE_PERSONAL_SQL, ROOM_RECORD_SCHEMA_SQL } from "./identity-rollback-guard.mjs";

const imageTag = "a".repeat(40);
const options = { envFile: "test.env", composeFile: "compose.test.yml", imageTag };
function host({ floor = "2", bound = "f", policyExists = "t", authorityExists = "t", roomsExists = "t", schema = "t", ownerless = "f", apiLabel = "1", stateLabel = "1", readerLabel = "2",
  apiCodec = "2", browserCodec = "2", mediaCodec = "2", screenReconciler = "2", browser = true, browserTag = imageTag, malformed = false, database = "postgres://vrata:test-only@postgres:5432/vrata",
  codecColumn = "f", policyCodec = "2", codecBoundary = "", rotationColumn = "f", rotated = "f", rotationLabel = "" } = {}) {
  const mutations = [], inspections = [];
  return { mutations, inspections, run(args, env) {
    const query = args.at(-1);
    if (query === "select to_regclass('room_identity_protocol_policy') is not null") return policyExists;
    if (query === "select to_regclass('room_identity_authority_v2') is not null") return authorityExists;
    if (query === "select minimum_protocol from room_identity_protocol_policy where singleton=true") return floor;
    if (query === "select exists(select 1 from room_identity_authority_v2)") return bound;
    if (query.startsWith("select exists(select 1 from pg_attribute where attrelid=to_regclass('room_identity_protocol_policy') and attname='media_codec'")) return codecColumn;
    if (query === "select media_codec from room_identity_protocol_policy where singleton=true") return policyCodec;
    if (query.startsWith("select exists(select 1 from pg_attribute where attrelid=to_regclass('room_identity_protocol_policy') and attname='rotated_media_namespace'")) return rotationColumn;
    if (query === "select rotated_media_namespace is not null from room_identity_protocol_policy where singleton=true") return rotated;
    if (query === "select to_regclass('rooms') is not null") return roomsExists;
    if (query === ROOM_RECORD_SCHEMA_SQL) return schema;
    if (query === OWNERLESS_REFERENCE_PERSONAL_SQL) {
      if (ownerless === null) throw new Error("identity_rollout_probe_failed");
      return ownerless;
    }
    if (args.includes("--format") && args.includes("json")) {
      if (env) assert.equal(env.IMAGE_TAG, imageTag, "candidate rendering uses an environment override, not an env-file write");
      return malformed ? "secret-containing-malformed-model" : JSON.stringify({ services: {
        api: { image: `registry/api:${imageTag}`, environment: { POSTGRES_URL: database } },
        "room-state": { image: `registry/room-state:${imageTag}` },
        ...(browser ? { "remote-browser": { image: `registry/remote-browser:${browserTag}` } } : {}),
        postgres: { environment: { POSTGRES_USER: "vrata", POSTGRES_DB: "vrata" } }
      } });
    }
    if (args[0] === "pull") { mutations.push([...args]); return ""; }
    if (args[0] === "image" && args[1] === "inspect") {
      inspections.push([args[3], query]);
      if (args[3].includes("io.vrata.media-identity-codec")) return mediaCodec;
      if (args[3].includes("io.vrata.media-screen-reconciler")) return screenReconciler;
      if (args[3].includes("io.vrata.media-codec-boundary")) return codecBoundary;
      if (args[3].includes("io.vrata.media-namespace-rotation")) return rotationLabel;
      if (args[3].includes("io.vrata.frame-token-codec")) return query.includes("/remote-browser:") ? browserCodec : query.includes("/api:") ? apiCodec : "";
      if (args[3].includes("io.vrata.room-record-reader")) return query.includes("/api:") ? readerLabel : "";
      return query.includes("room-state:") ? stateLabel : apiLabel;
    }
    throw new Error("unexpected_command");
  } };
}

test("unbound legacy databases retain ordinary tag rollback", () => {
  for (const config of [{ floor: "1" }, { policyExists: "f", authorityExists: "f" }, { policyExists: "f", authorityExists: "f", roomsExists: "f" }]) {
    const adapter = host(config);
    assertIdentityRollbackTarget({ ...options, imageTag: "0.1.0" }, adapter.run);
    assert.deepEqual(adapter.mutations, []);
  }
});

test("scoped media requires the paired API/runtime codec only after floor-two activation", () => {
  for (const mediaCodec of ["", "<no value>", "1", "3", "02", "2.0", "true"]) {
    assert.throws(() => assertIdentityRollbackTarget(options, host({ mediaCodec }).run), /media_rollback_requires_identity_codec2:api/);
    assertIdentityRollbackTarget(options, host({ floor: "1", bound: "t", mediaCodec }).run);
  }
});

test("floor-two rollback cannot silently remove terminal user-media eviction", () => {
  for (const screenReconciler of ["", "<no value>", "0", "1", "3", "02", "2.0", "true"]) {
    assert.throws(() => assertIdentityRollbackTarget(options, host({ screenReconciler }).run), /media_rollback_requires_screen_reconciler2:api/);
    assertIdentityRollbackTarget(options, host({ floor: "1", bound: "t", screenReconciler }).run);
  }
});

test("a raised media codec boundary refuses a rollback image that would issue codec-2 grants again", () => {
  for (const config of [{}, { codecColumn: "t" }, { codecColumn: "t", policyCodec: "2" }]) assertIdentityRollbackTarget(options, host(config).run);
  for (const codecBoundary of ["", "<no value>", "2", "02x", "true"]) {
    assert.throws(() => assertIdentityRollbackTarget(options, host({ codecColumn: "t", policyCodec: "3", codecBoundary }).run),
      /media_rollback_below_codec_boundary_forbidden:api/);
  }
  assertIdentityRollbackTarget(options, host({ codecColumn: "t", policyCodec: "3", codecBoundary: "3" }).run);
  for (const corrupt of [{ codecColumn: "" }, { codecColumn: "t", policyCodec: "" }, { codecColumn: "t", policyCodec: "4" }, { codecColumn: "t", policyCodec: "3\n3" }]) {
    assert.throws(() => assertIdentityRollbackTarget(options, host(corrupt).run), /media_rollout_invalid_codec_boundary/);
  }
});

test("a rotated media namespace refuses a rollback image that would issue in the activation namespace", () => {
  for (const config of [{}, { rotationColumn: "t" }, { rotationColumn: "t", rotated: "f" }]) assertIdentityRollbackTarget(options, host(config).run);
  for (const rotationLabel of ["", "<no value>", "0", "true"]) {
    assert.throws(() => assertIdentityRollbackTarget(options, host({ rotationColumn: "t", rotated: "t", rotationLabel }).run),
      /media_rollback_without_namespace_rotation_forbidden:api/);
  }
  assertIdentityRollbackTarget(options, host({ rotationColumn: "t", rotated: "t", rotationLabel: "1" }).run);
  for (const corrupt of [{ rotationColumn: "" }, { rotationColumn: "t", rotated: "" }, { rotationColumn: "t", rotated: "1" }]) {
    assert.throws(() => assertIdentityRollbackTarget(options, host(corrupt).run), /media_rollout_invalid_namespace_rotation/);
  }
});

test("both application images must implement the boundary after activation or binding", () => {
  for (const config of [{}, { floor: "1", bound: "t" }]) {
    for (const broken of [{ apiLabel: "" }, { stateLabel: "<no value>" }]) {
      const adapter = host({ ...config, ...broken });
      assert.throws(() => assertIdentityRollbackTarget(options, adapter.run), /identity_rollback_below_boundary_forbidden/);
      assert(adapter.mutations.every(command => command[0] === "pull"), "guard never updates an env file or runs services");
    }
    const adapter = host(config);
    assertIdentityRollbackTarget(options, adapter.run);
    assert.deepEqual(adapter.mutations, ["api", "room-state", "remote-browser"].map(service => ["pull", `registry/${service}:${imageTag}`]));
  }
});

test("missing/corrupt floor or binding and mutable tags fail closed", () => {
  for (const config of [{ floor: "" }, { floor: "0" }, { floor: "1\n2" }, { policyExists: "unknown" }, { bound: "" }]) {
    const adapter = host(config);
    assert.throws(() => assertIdentityRollbackTarget(options, adapter.run), /identity_rollout_invalid_policy/);
    assert.deepEqual(adapter.mutations, []);
  }
  const adapter = host();
  assert.throws(() => assertIdentityRollbackTarget({ ...options, imageTag: "0.1.0" }, adapter.run), /identity_rollback_requires_immutable_sha/);
  assert.deepEqual(adapter.mutations, []);
});

test("invalid compose output does not leak environment contents", () => {
  const adapter = host({ malformed: true });
  assert.throws(() => assertIdentityRollbackTarget(options, adapter.run), error => error.message === "identity_rollout_invalid_compose_model");
});

test("an external database or different namespace cannot be mistaken for an unbound local database", () => {
  for (const database of ["postgres://vrata:private-value@external/vrata", "postgres://other:private-value@postgres/vrata", "postgres://vrata:private-value@postgres/vrata?options=other-schema"]) {
    const adapter = host({ database });
    assert.throws(() => assertIdentityRollbackTarget(options, adapter.run), error => error.message === "identity_rollout_requires_matching_bundled_database");
    assert.deepEqual(adapter.mutations, []);
  }
});

test("floor two requires a room-record reader two API even without ownerless records", () => {
  for (const readerLabel of ["", "<no value>", "0", "1", "true", "2.0", "02", "+2", " 2", "2\n3", "9007199254740993"]) {
    const adapter = host({ readerLabel });
    assert.throws(() => assertIdentityRollbackTarget(options, adapter.run), error => error.message === "room_record_rollback_requires_reader2:api");
    assert(adapter.mutations.every(command => command[0] === "pull"), "guard never updates an env file or runs services");
  }
  for (const readerLabel of ["2", "3"]) assertIdentityRollbackTarget(options, host({ readerLabel }).run);
});

test("ownerless personal reference records require reader two on an unbound floor-one database", () => {
  for (const legacy of [{ floor: "1", ownerless: "t" }, { policyExists: "f", authorityExists: "f", ownerless: "t" }]) {
    let adapter = host(legacy);
    assert.throws(() => assertIdentityRollbackTarget({ ...options, imageTag: "0.1.0" }, adapter.run), /identity_rollback_requires_immutable_sha/);
    assert.deepEqual(adapter.mutations, []);
    adapter = host({ ...legacy, readerLabel: "<no value>" });
    assert.throws(() => assertIdentityRollbackTarget(options, adapter.run), error => error.message === "room_record_rollback_requires_reader2:api");
    assert.deepEqual(adapter.mutations, [["pull", `registry/api:${imageTag}`]]);
    adapter = host({ ...legacy, apiLabel: "", stateLabel: "" });
    assertIdentityRollbackTarget(options, adapter.run);
    assert.deepEqual(adapter.mutations, [["pull", `registry/api:${imageTag}`]]);
  }
  assertIdentityRollbackTarget(options, host({ floor: "1", bound: "t", readerLabel: "" }).run);
});

test("missing, partial, or corrupt room-record probes fail closed without leaking output", () => {
  for (const config of [{ ownerless: "" }, { ownerless: "private-room-id" }, { ownerless: "t\nf" }, { schema: "f" }, { schema: "" },
    { roomsExists: "unknown" }, { roomsExists: "f" }, { roomsExists: "f", policyExists: "f" }, { roomsExists: "f", authorityExists: "f" }]) {
    const adapter = host({ floor: "1", ...config });
    assert.throws(() => assertIdentityRollbackTarget({ ...options, imageTag: "0.1.0" }, adapter.run), error => error.message === "room_record_rollout_invalid_reference_state");
    assert.deepEqual(adapter.mutations, []);
  }
  const adapter = host({ floor: "1", ownerless: null });
  assert.throws(() => assertIdentityRollbackTarget(options, adapter.run), error => error.message === "identity_rollout_probe_failed");
  assert.deepEqual(adapter.mutations, []);
});

test("frame-token codec two is required on the API and a present remote-browser after activation or binding", () => {
  const codecFormat = '{{ index .Config.Labels "io.vrata.frame-token-codec" }}';
  for (const config of [{}, { floor: "1", bound: "t" }]) {
    for (const value of ["", "<no value>", "0", "1", "3", "02", "+2", " 2", "2.0", "2\n2", "true"]) {
      for (const [broken, service] of [[{ apiCodec: value }, "api"], [{ browserCodec: value }, "remote-browser"]]) {
        const adapter = host({ ...config, ...broken });
        assert.throws(() => assertIdentityRollbackTarget(options, adapter.run), error => error.message === `frame_rollback_requires_codec2:${service}`);
        assert(adapter.mutations.every(command => command[0] === "pull"), "guard never updates an env file or runs services");
      }
    }
    for (const browserTag of ["b".repeat(40), "latest", `${imageTag}-old`]) {
      const adapter = host({ ...config, browserTag });
      assert.throws(() => assertIdentityRollbackTarget(options, adapter.run), error => error.message === "frame_rollback_requires_codec2:remote-browser");
      assert.deepEqual(adapter.mutations, [["pull", `registry/api:${imageTag}`], ["pull", `registry/room-state:${imageTag}`]], "a mismatched browser image is never pulled");
    }
    const adapter = host(config);
    assertIdentityRollbackTarget(options, adapter.run);
    assert.deepEqual(adapter.mutations, ["api", "room-state", "remote-browser"].map(service => ["pull", `registry/${service}:${imageTag}`]));
    assert.deepEqual(adapter.inspections.filter(([, image]) => image.includes("/remote-browser:")).map(([format]) => format), [codecFormat],
      "the browser carries no identity-floor or reader requirement");
  }
});

test("an absent remote-browser consumer is skipped while the API producer still requires codec two", () => {
  for (const config of [{}, { floor: "1", bound: "t" }]) {
    let adapter = host({ ...config, browser: false });
    assertIdentityRollbackTarget(options, adapter.run);
    assert.deepEqual(adapter.mutations, [["pull", `registry/api:${imageTag}`], ["pull", `registry/room-state:${imageTag}`]]);
    for (const apiCodec of ["", "<no value>", "1"]) {
      adapter = host({ ...config, browser: false, apiCodec });
      assert.throws(() => assertIdentityRollbackTarget(options, adapter.run), error => error.message === "frame_rollback_requires_codec2:api");
      assert(adapter.mutations.every(command => command[0] === "pull"));
    }
  }
});

test("identity boundary and reader failures keep priority over the frame-token gate", () => {
  for (const [config, code] of [
    [{ apiLabel: "", apiCodec: "1", browserCodec: "" }, "identity_rollback_below_boundary_forbidden:api"],
    [{ stateLabel: "<no value>", apiCodec: "1", browserTag: "latest" }, "identity_rollback_below_boundary_forbidden:room-state"],
    [{ readerLabel: "1", apiCodec: "1", browserCodec: "1" }, "room_record_rollback_requires_reader2:api"],
    [{ floor: "1", bound: "t", ownerless: "t", readerLabel: "", apiCodec: "" }, "room_record_rollback_requires_reader2:api"]
  ]) {
    const adapter = host(config);
    assert.throws(() => assertIdentityRollbackTarget(options, adapter.run), error => error.message === code);
    assert(adapter.inspections.every(([format]) => !format.includes("frame-token-codec")));
    assert(!adapter.mutations.some(([, image]) => image.includes("/remote-browser:")));
  }
});

test("unbound legacy databases are not subject to the frame-token gate", () => {
  const codecless = { apiCodec: "", browserCodec: "1", browserTag: "0.0.1" };
  for (const config of [{ floor: "1" }, { policyExists: "f", authorityExists: "f" }]) {
    let adapter = host({ ...config, ...codecless });
    assertIdentityRollbackTarget({ ...options, imageTag: "0.1.0" }, adapter.run);
    assert.deepEqual(adapter.mutations, []);
    adapter = host({ ...config, ...codecless, ownerless: "t" });
    assertIdentityRollbackTarget(options, adapter.run);
    assert.deepEqual(adapter.mutations, [["pull", `registry/api:${imageTag}`]]);
    assert(adapter.inspections.every(([format]) => !format.includes("frame-token-codec")));
  }
});
