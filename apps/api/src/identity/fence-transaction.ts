import { DatabaseError, type Pool, type PoolClient } from "pg";
import type { LegacyRoomEffectOptions } from "../storage-contracts.js";

export class RoomFenceCommitUncertain extends Error {
  constructor(cause: unknown) { super("room_fence_commit_unconfirmed", { cause }); this.name = "RoomFenceCommitUncertain"; }
}

export class RoomFenceUnavailable extends Error {
  constructor(cause: unknown) { super("room_fence_connection_unavailable", { cause }); this.name = "RoomFenceUnavailable"; }
}

export function uncertainRoomCommit(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (current instanceof RoomFenceCommitUncertain) return true;
    current = current.cause;
  }
  return false;
}

function connectionFailure(error: unknown): boolean {
  if (error instanceof Error && ["Connection terminated unexpectedly", "Connection terminated",
    "Client has encountered a connection error and is not queryable"].includes(error.message)) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && ["25P03", "57P01", "57P02", "57P03",
    "08000", "08001", "08003", "08006", "ECONNRESET", "EPIPE", "ECONNREFUSED", "ETIMEDOUT"].includes(code);
}

export function confirmedRoomWriteRejection(error: unknown): boolean {
  // Only an actual server ErrorResponse proves rejection. Unknown client-side
  // failures (including read timeout/TLS/proxy errors) can lose a successful ack.
  return error instanceof DatabaseError && error.severity === "ERROR" && typeof error.code === "string" && /^[0-9A-Z]{5}$/.test(error.code)
    && !["08", "57", "XX"].some(prefix => error.code!.startsWith(prefix));
}

export function identityFenceUnavailable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return error instanceof RoomFenceUnavailable || uncertainRoomCommit(error) || connectionFailure(error)
    || typeof code === "string" && ["55P03", "40P01", "40001", "57014"].includes(code);
}

function duration(value: number | undefined, fallback: number): string {
  const milliseconds = value ?? fallback;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 60_000) throw new Error("invalid_room_fence_timeout");
  return `${milliseconds}ms`;
}

export async function roomFenceTransaction<T>(pool: Pool, options: LegacyRoomEffectOptions,
  effect: (client: PoolClient, checkAlive: () => void) => Promise<T>): Promise<T> {
  const lock = duration(options.lockTimeoutMs, 5000);
  const idle = duration(options.idleTimeoutMs, 10_000);
  let client: PoolClient;
  try { client = await pool.connect(); }
  catch (error) { throw new RoomFenceUnavailable(error); }
  let failedConnection: Error | undefined;
  let active = true;
  let committing = false;
  const onError = (error: Error) => { failedConnection ??= error; };
  client.on("error", onError);
  try {
    await client.query("begin isolation level read committed");
    await client.query("select set_config('lock_timeout',$1,true),set_config('idle_in_transaction_session_timeout',$2,true)", [lock, idle]);
    const result = await effect(client, () => {
      if (!active) throw new Error("room_effect_scope_closed");
      if (failedConnection) throw failedConnection;
    });
    active = false;
    if (failedConnection) throw failedConnection;
    committing = true;
    await client.query("commit");
    return result;
  } catch (error) {
    active = false;
    if (connectionFailure(error)) failedConnection ??= error instanceof Error ? error : new Error("room_fence_connection_failed");
    await client.query("rollback").catch(rollbackError => {
      failedConnection ??= rollbackError instanceof Error ? rollbackError : new Error("room_fence_connection_failed");
    });
    const failure = failedConnection ?? error;
    if (committing && (!confirmedRoomWriteRejection(error) || connectionFailure(failedConnection))) throw new RoomFenceCommitUncertain(failure);
    throw failure;
  } finally {
    active = false;
    client.release(failedConnection);
    client.off("error", onError);
  }
}
