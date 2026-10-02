import assert from "node:assert/strict";
import test from "node:test";
import { finalizeProofBoundToken, type ProofBoundEffectActor } from "./effect-fence.js";
import type { VerifiedRoomRequestV2 } from "./http-authority.js";

function snapshot(overrides: { epoch?: number; role?: "member" | "presenter"; owner?: boolean; roomId?: string } = {}): VerifiedRoomRequestV2 {
  return { room: { roomId: overrides.roomId ?? "room", tenantId: "tenant" },
    identity: { identityId: "identity", participantId: "participant", authEpoch: overrides.epoch ?? 1 },
    role: overrides.role ?? "presenter", isOwner: overrides.owner ?? false
  } as VerifiedRoomRequestV2;
}

const actor: ProofBoundEffectActor = { tenantId: "tenant", roomId: "room", identityId: "identity",
  participantId: "participant", authEpoch: 1, role: "presenter", isOwner: false };

test("an asynchronously signed token is discarded when revocation or role change commits before the final read", async () => {
  let releaseSign!: () => void;
  let signStarted!: () => void;
  const started = new Promise<void>(resolve => { signStarted = resolve; });
  const signing = new Promise<void>(resolve => { releaseSign = resolve; });
  let current: VerifiedRoomRequestV2 | null = snapshot();
  const issued = finalizeProofBoundToken({ before: actor,
    prepare: async () => { signStarted(); await signing; return "prepared-token"; },
    readCurrent: async () => current });
  await started;
  current = null;
  releaseSign();
  assert.equal(await issued, null);
  for (const changed of [snapshot({ epoch: 2 }), snapshot({ role: "member" }), snapshot({ owner: true }), snapshot({ roomId: "elsewhere" })]) {
    assert.equal(await finalizeProofBoundToken({ before: actor, prepare: async () => "prepared-token", readCurrent: async () => changed }), null);
  }
  assert.equal(await finalizeProofBoundToken({ before: actor, prepare: async () => "allowed-token", readCurrent: async () => snapshot() }), "allowed-token");
});
