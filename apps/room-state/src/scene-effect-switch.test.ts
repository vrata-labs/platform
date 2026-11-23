import assert from "node:assert/strict";
import { test } from "node:test";
import type { ParticipantAccessState } from "./state.js";
import { admitSceneEffectSwitches, setSceneEffectSwitch } from "./scene-effect-switch.js";

test("the confirmed switch survives joins, accepts explicit host updates, and cannot cross scene versions", () => {
  const sceneEffectSwitches = { versionId: "version-1", switches: [{ id: "hearth", enabled: true }, { id: "other", enabled: false }] };
  const host: ParticipantAccessState = { role: "host", sceneEffectSwitches, sceneEffectVersionId: "version-1" };
  const before = admitSceneEffectSwitches(undefined, host);
  assert.equal(before, sceneEffectSwitches);
  const command = { versionId: "version-1", effectId: "hearth", enabled: false };
  for (const access of [null, { ...host, role: "guest" } as const, { ...host, sceneEffectVersionId: "version-2" }]) {
    assert.equal(setSceneEffectSwitch(before, access, command), before);
  }
  assert.equal(setSceneEffectSwitch(before, host, { ...command, versionId: "other" }), before);
  assert.equal(setSceneEffectSwitch(before, host, { ...command, effectId: "constructor" }), before);
  const after = setSceneEffectSwitch(before, host, command);
  assert.deepEqual(after?.switches, [{ id: "hearth", enabled: false }, { id: "other", enabled: false }]);
  assert.equal(setSceneEffectSwitch(after, host, command), after);
  assert.equal(admitSceneEffectSwitches(after, host), after);
  assert.equal(admitSceneEffectSwitches(after, { ...host, sceneEffectVersionId: "version-2" }), undefined);
});
