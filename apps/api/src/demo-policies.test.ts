import assert from "node:assert/strict";
import test from "node:test";

import { loadDemoPolicies, parseDemoPolicies } from "./demo-policies.js";

const qa = {
  policyId: "qa-demo-v1", templates: ["meeting-room-basic", "presentation-room-basic"], absoluteLifetimeSeconds: 1800, idleTimeoutSeconds: 600,
  maxParticipants: 4, maxConcurrentInstances: 5, creationRateLimit: { perIpPerHour: 3, perBrowserPerHour: 3 },
  features: { voice: true, screenShare: false, documents: false, upload: false, remoteBrowser: false },
  killSwitch: { creationEnabled: true }, mediaBudget: { alertAtParticipantMinutesPerDay: 600 }
};

test("demo policies take the platform part of the portal policy and refuse anything outside the schema limits", () => {
  const policies = parseDemoPolicies(JSON.stringify([qa]));
  assert.deepEqual(policies.get("qa-demo-v1"), {
    policyId: "qa-demo-v1", templates: ["meeting-room-basic", "presentation-room-basic"], absoluteLifetimeSeconds: 1800, idleTimeoutSeconds: 600,
    maxParticipants: 4, features: { voice: true, screenShare: false, documents: false }
  });
  assert.equal(parseDemoPolicies(undefined).size, 0);
  assert.equal(loadDemoPolicies({}).size, 0);
  for (const [change, reason] of [
    [{ templates: ["personal-room-basic"] }, "templates"],
    [{ templates: [] }, "templates"],
    [{ absoluteLifetimeSeconds: 7200 }, "absolute_lifetime"],
    [{ idleTimeoutSeconds: 10 }, "idle_timeout"],
    [{ maxParticipants: 9 }, "max_participants"],
    [{ features: { ...qa.features, upload: true } }, "features"],
    [{ features: { ...qa.features, remoteBrowser: true } }, "features"],
    [{ policyId: "QA" }, "policy_id"]
  ] as const) {
    assert.throws(() => parseDemoPolicies(JSON.stringify([{ ...qa, ...change }])), new RegExp(`invalid_demo_policies:${reason}`), JSON.stringify(change));
  }
  assert.throws(() => parseDemoPolicies(JSON.stringify([qa, qa])), /duplicate/);
  assert.throws(() => parseDemoPolicies("{"), /json/);
  assert.throws(() => parseDemoPolicies(JSON.stringify(qa)), /not_array/);
});
