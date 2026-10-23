import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Pool } from "pg";
import { createPostgresIdentityProtocol } from "./protocol.js";

/** Counts only: no room IDs, names, identities or credentials leave the database. */
export interface IdentityActivationAudit {
  rooms: number;
  disabledRooms: number;
  lockedRooms: number;
  endedRooms: number;
  boundRooms: number;
}
export interface IdentityActivationResult {
  before: number;
  after: number;
  raised: boolean;
  dryRun: boolean;
  audit: IdentityActivationAudit;
}

/** Operator action for a deployment whose images already carry the v2 boundary capabilities.
 * Raising the persistent floor is irreversible. Saved lock/end/disable decisions are reported
 * before the raise and kept as they are; nothing is cleared or migrated here. */
export async function activateIdentityProtocolV2(pool: Pool, options: { dryRun: boolean }): Promise<IdentityActivationResult> {
  const policy = createPostgresIdentityProtocol(pool);
  const before = await policy.minimum();
  const row = (await pool.query(`select count(*)::int as rooms,
      count(*) filter (where status = 'disabled' or disabled_at is not null)::int as "disabledRooms",
      count(*) filter (where nullif(session_control->>'lockedAt', '') is not null)::int as "lockedRooms",
      count(*) filter (where nullif(session_control->>'endedAt', '') is not null)::int as "endedRooms",
      (select count(*)::int from room_identity_authority_v2) as "boundRooms"
    from rooms`)).rows[0] as IdentityActivationAudit;
  const audit: IdentityActivationAudit = { rooms: row.rooms, disabledRooms: row.disabledRooms, lockedRooms: row.lockedRooms,
    endedRooms: row.endedRooms, boundRooms: row.boundRooms };
  if (options.dryRun || before >= 2) return { before, after: before, raised: false, dryRun: options.dryRun, audit };
  const after = await policy.raise(2);
  if (after !== 2 || await policy.minimum() !== 2 || !await policy.mediaNamespace()) throw new Error("identity_activation_not_confirmed");
  return { before, after, raised: true, dryRun: false, audit };
}

async function operatorMain(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  let pool: Pool | undefined;
  try {
    if (!dryRun && !args.has("--confirm-irreversible")) throw new Error("identity_activation_confirmation_required");
    if ([...args].some(arg => arg !== "--dry-run" && arg !== "--confirm-irreversible")) throw new Error("identity_activation_invalid_arguments");
    if (!process.env.POSTGRES_URL) throw new Error("identity_activation_database_required");
    pool = new Pool({ connectionString: process.env.POSTGRES_URL, max: 1 });
    process.stdout.write(`${JSON.stringify({ ok: true, ...await activateIdentityProtocolV2(pool, { dryRun }) })}\n`);
  } catch (error) {
    // Fixed codes only: no connection strings, SQL or stack traces.
    const message = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "identity_activation_failed";
    process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`); process.exitCode = 1;
  } finally { await pool?.end(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await operatorMain();
