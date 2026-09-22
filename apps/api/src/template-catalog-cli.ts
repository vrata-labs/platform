import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Pool } from "pg";
import { referenceCatalogState } from "@vrata/templates";
import { PostgresStorage } from "./storage.js";
import { preflightReferenceTemplateAssets } from "./reference-template-preflight.js";

export function parseTemplateCatalogCommand(argv: string[], env: NodeJS.ProcessEnv) {
  const [mode, ...args] = argv;
  if (!["status", "preflight", "activate", "rollback"].includes(mode ?? "")) throw new Error("invalid_template_catalog_command");
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!, value = args[index+1];
    if (!["--expected-image-sha", "--rollback-sha"].includes(key) || !value || options.has(key)) throw new Error("invalid_template_catalog_arguments");
    options.set(key, value);
  }
  if (mode === "activate" || mode === "rollback") {
    const expected = options.get("--expected-image-sha");
    if (!expected || !/^[a-f0-9]{40}$/.test(expected) || expected !== env.VRATA_DEPLOY_SHA) throw new Error("template_catalog_image_mismatch");
    if (mode === "activate") {
      const rollback = options.get("--rollback-sha");
      if (!rollback || !/^[a-f0-9]{40}$/.test(rollback)) throw new Error("template_catalog_rollback_target_required");
      if (rollback !== env.VRATA_TEMPLATE_WAVE2_SHA) throw new Error("template_catalog_rollback_marker_mismatch");
    }
  }
  return { mode: mode!, expectedImageSha: options.get("--expected-image-sha"), rollbackSha: options.get("--rollback-sha") };
}

export async function runTemplateCatalogCommand(argv: string[], env: NodeJS.ProcessEnv = process.env) {
  const command = parseTemplateCatalogCommand(argv, env);
  if (command.mode === "preflight") return preflightReferenceTemplateAssets(fetch, env);
  if (!env.POSTGRES_URL) throw new Error("template_catalog_postgres_required");
  if (command.mode === "activate") await preflightReferenceTemplateAssets(fetch, env);
  const pool = new Pool({ connectionString: env.POSTGRES_URL });
  try {
    if (command.mode !== "status") {
      const storage = new PostgresStorage(pool);
      await storage.transitionReferenceTemplateCatalog(command.mode === "activate" ? "active" : "wave2");
    }
    const result = await pool.query("select template_id, current_version, status from templates order by template_id");
    const catalog = result.rows.map(row => ({ templateId: row.template_id as string, currentVersion: row.current_version as string, status: row.status as "active" | "deprecated" }));
    const rooms = await pool.query("select count(*)::int as count from rooms where template_version <> '0.1.0'");
    return { state: referenceCatalogState(catalog), imageSha: env.VRATA_DEPLOY_SHA ?? null, referenceRoomCount: rooms.rows[0].count as number, catalog };
  } finally { await pool.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runTemplateCatalogCommand(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error instanceof Error ? error.message : "template_catalog_command_failed"); process.exitCode = 1;
  });
}
