import type { Pool } from "pg";
import { admissionWindows, assertAdmissionLimitInput, type AdmissionLimitInput } from "./admission-limits.js";

/** Hashed network peers share a budget across rooms and API replicas. Renewals,
 * approved waiting proofs and administrator recovery do not allocate a slot. */
export function createMemoryAdmissionBudget(now = Date.now) {
  const counters = new Map<string, { count: number; windowStartMs: number; windowMs: number }>();
  return async (input: AdmissionLimitInput): Promise<boolean> => {
    assertAdmissionLimitInput(input);
    const at = now();
    if (!Number.isSafeInteger(at) || at < 0) throw new Error("invalid_identity_admission_clock");
    const windows = admissionWindows(input.kind).map(rule => ({ ...rule,
      windowStartMs: Math.floor(at / rule.windowMs) * rule.windowMs }));
    if (windows.some(rule => (counters.get(`${input.originHash}:${input.kind}:${rule.windowMs}:${rule.windowStartMs}`)?.count ?? 0) >= rule.limit)) return false;
    for (const rule of windows) {
      const key = `${input.originHash}:${input.kind}:${rule.windowMs}:${rule.windowStartMs}`;
      counters.set(key, { count: (counters.get(key)?.count ?? 0) + 1, windowMs: rule.windowMs, windowStartMs: rule.windowStartMs });
    }
    if (counters.size > 2048) {
      for (const [key, value] of counters) if (value.windowStartMs + value.windowMs <= at) counters.delete(key);
    }
    return true;
  };
}

export function createPostgresAdmissionBudget(pool: Pool, now = Date.now) {
  let requestsSincePrune = 0;
  return async (input: AdmissionLimitInput): Promise<boolean> => {
    assertAdmissionLimitInput(input);
    const at = now();
    if (!Number.isSafeInteger(at) || at < 0) throw new Error("invalid_identity_admission_clock");
    const client = await pool.connect();
    let admitted = false;
    try {
      await client.query("begin");
      for (const rule of admissionWindows(input.kind)) {
        const start = Math.floor(at / rule.windowMs) * rule.windowMs;
        const result = await client.query(`insert into room_identity_admission_buckets_v2
          (origin_hash,kind,window_ms,window_start_ms,attempts) values ($1,$2,$3,$4,1)
          on conflict (origin_hash,kind,window_ms,window_start_ms)
          do update set attempts=room_identity_admission_buckets_v2.attempts+1
            where room_identity_admission_buckets_v2.attempts<$5 returning attempts`,
        [input.originHash, input.kind, rule.windowMs, start, rule.limit]);
        if (!result.rowCount) {
          await client.query("rollback");
          return false;
        }
      }
      await client.query("commit");
      admitted = true;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally { client.release(); }
    if (admitted && ++requestsSincePrune % 64 === 0) {
      // The oldest daily bucket is already closed. Reclamation never touches
      // immutable room identities or a still-usable admission window.
      await pool.query("delete from room_identity_admission_buckets_v2 where window_start_ms<$1", [at - 86_400_000]).catch(() => undefined);
    }
    return admitted;
  };
}
