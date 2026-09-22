import type { Pool } from "pg";
import { expectedReferenceCatalog, getTemplateVersion, listReferenceTemplateVersionContracts, planReferenceCatalogTransition, type ReferenceCatalogState, type TemplateCatalogPointer } from "@vrata/templates";
import { parseStoredTemplateVersion, stableJson, type StoredTemplateVersionRow } from "./storage-room-records.js";

export async function transitionPostgresReferenceCatalog(pool: Pick<Pool, "connect">, target: ReferenceCatalogState): Promise<TemplateCatalogPointer[]> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended('vrata:postgres-storage-init:v1', 0))");
    const result = await client.query("select template_id, current_version, status from templates order by template_id for update");
    const catalog = result.rows.map((row: { template_id: string; current_version: string; status: "active" | "deprecated" }) => ({ templateId: row.template_id, currentVersion: row.current_version, status: row.status }));
    const changes = planReferenceCatalogTransition(catalog, target);
    const referenceVersions = listReferenceTemplateVersionContracts();
    for (const pointer of expectedReferenceCatalog(target)) {
      const expected = pointer.currentVersion === "0.1.0"
        ? getTemplateVersion(pointer.templateId, pointer.currentVersion)
        : referenceVersions.find(version => version.templateId === pointer.templateId && version.version === pointer.currentVersion);
      if (!expected) throw new Error("template_catalog_definition_missing");
      const stored = await client.query("select template_id, version, snapshot, content_hash from template_versions where template_id = $1 and version = $2", [pointer.templateId, pointer.currentVersion]);
      if (!stored.rows[0] || stableJson(parseStoredTemplateVersion(stored.rows[0] as StoredTemplateVersionRow)) !== stableJson(expected)) throw new Error("template_catalog_definition_mismatch");
    }
    for (const pointer of changes) {
      const updated = await client.query("update templates set status = $2, current_version = $3 where template_id = $1", [pointer.templateId, pointer.status, pointer.currentVersion]);
      if (updated.rowCount !== 1) throw new Error("template_catalog_update_failed");
    }
    await client.query("commit");
    return catalog.map(value => changes.find(change => change.templateId === value.templateId) ?? value);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { client.release(); }
}
