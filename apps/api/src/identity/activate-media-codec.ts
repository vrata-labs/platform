import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Pool } from "pg";
import { createPostgresIdentityProtocol } from "./protocol.js";

export interface MediaCodecActivationResult {
  before: number;
  after: number;
  raised: boolean;
  dryRun: boolean;
}

/** Operator action for a deployment whose candidate and rollback images both enforce the codec-3
 * media boundary. Irreversible: codec-2 grants are no longer issued and existing codec-2 rooms are
 * retired by the reconciler; open tabs lose their media connection and join audio again with codec-3
 * grants. Identity floor stays 2. */
export async function activateMediaCodec3(pool: Pool, options: { dryRun: boolean }): Promise<MediaCodecActivationResult> {
  const policy = createPostgresIdentityProtocol(pool);
  if (await policy.minimum() < 2) throw new Error("media_codec_requires_identity_v2");
  const boundary = await policy.mediaBoundary();
  if (!boundary) throw new Error("media_codec_requires_identity_v2");
  const before = boundary.codec;
  if (options.dryRun || before >= 3) return { before, after: before, raised: false, dryRun: options.dryRun };
  const after = await policy.raiseMediaCodec(3);
  if (after !== 3 || (await policy.mediaBoundary())?.codec !== 3) throw new Error("media_codec_activation_not_confirmed");
  return { before, after, raised: true, dryRun: false };
}

async function operatorMain(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  let pool: Pool | undefined;
  try {
    if (!dryRun && !args.has("--confirm-irreversible")) throw new Error("media_codec_activation_confirmation_required");
    if ([...args].some(arg => arg !== "--dry-run" && arg !== "--confirm-irreversible")) throw new Error("media_codec_activation_invalid_arguments");
    if (!process.env.POSTGRES_URL) throw new Error("media_codec_activation_database_required");
    pool = new Pool({ connectionString: process.env.POSTGRES_URL, max: 1 });
    process.stdout.write(`${JSON.stringify({ ok: true, ...await activateMediaCodec3(pool, { dryRun }) })}\n`);
  } catch (error) {
    // Fixed codes only: no connection strings, SQL or stack traces.
    const message = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "media_codec_activation_failed";
    process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`); process.exitCode = 1;
  } finally { await pool?.end(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await operatorMain();
