import assert from "node:assert/strict";
import test from "node:test";
import { assertIdentityRollbackTarget } from "./identity-rollback-guard.mjs";

const imageTag = "a".repeat(40);
const options = { envFile: "test.env", composeFile: "compose.test.yml", imageTag };
function host({ floor = "2", bound = "f", policyExists = "t", authorityExists = "t", apiLabel = "1", stateLabel = "1", malformed = false, database = "postgres://vrata:test-only@postgres:5432/vrata" } = {}) {
  const mutations = [];
  return { mutations, run(args, env) {
    const query = args.at(-1);
    if (query === "select to_regclass('room_identity_protocol_policy') is not null") return policyExists;
    if (query === "select to_regclass('room_identity_authority_v2') is not null") return authorityExists;
    if (query === "select minimum_protocol from room_identity_protocol_policy where singleton=true") return floor;
    if (query === "select exists(select 1 from room_identity_authority_v2)") return bound;
    if (args.includes("--format") && args.includes("json")) {
      if (env) assert.equal(env.IMAGE_TAG, imageTag, "candidate rendering uses an environment override, not an env-file write");
      return malformed ? "secret-containing-malformed-model" : JSON.stringify({ services: {
        api: { image: `registry/api:${imageTag}`, environment: { POSTGRES_URL: database } },
        "room-state": { image: `registry/room-state:${imageTag}` },
        postgres: { environment: { POSTGRES_USER: "vrata", POSTGRES_DB: "vrata" } }
      } });
    }
    if (args[0] === "pull") { mutations.push([...args]); return ""; }
    if (args[0] === "image" && args[1] === "inspect") return query.includes("room-state:") ? stateLabel : apiLabel;
    throw new Error("unexpected_command");
  } };
}

test("unbound legacy databases retain ordinary tag rollback", () => {
  for (const config of [{ floor: "1" }, { policyExists: "f", authorityExists: "f" }]) {
    const adapter = host(config);
    assertIdentityRollbackTarget({ ...options, imageTag: "0.1.0" }, adapter.run);
    assert.deepEqual(adapter.mutations, []);
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
    assert.equal(adapter.mutations.length, 2);
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
