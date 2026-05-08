import { strict as assert } from "node:assert";
import { test } from "node:test";

import { mergePresenceSources } from "./presence-sources.js";
import type { PresenceState } from "./index.js";

function participant(participantId: string, mode: PresenceState["mode"], z: number): PresenceState {
  return {
    participantId,
    displayName: participantId,
    mode,
    rootTransform: { x: 0, y: 0, z },
    bodyTransform: { x: 0, y: 0.92, z },
    headTransform: { x: 0, y: 1.58, z },
    muted: true,
    activeMedia: { audio: false, screenShare: false },
    updatedAt: new Date(z * 1000).toISOString()
  };
}

test("mergePresenceSources keeps fallback-only participants visible", () => {
  const merged = mergePresenceSources(
    [participant("realtime", "desktop", 1)],
    [participant("fallback", "mobile", 2)]
  );

  assert.deepEqual(merged.map((item) => item.participantId).sort(), ["fallback", "realtime"]);
});

test("mergePresenceSources lets realtime state win for duplicate participants", () => {
  const merged = mergePresenceSources(
    [participant("same", "vr", 3)],
    [participant("same", "desktop", 1)]
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.mode, "vr");
  assert.equal(merged[0]?.rootTransform.z, 3);
});
