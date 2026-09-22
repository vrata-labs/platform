import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function seedStagingTemplateFixtures(baseUrl, token, fetcher = fetch) {
  if (!baseUrl || !token) throw new Error("staging_fixture_configuration_required");
  const fixtures = JSON.parse(await readFile(new URL("../tests/e2e/staging-legacy-fixtures.json", import.meta.url), "utf8"));
  const headers = { "x-vrata-admin-token": token, "content-type": "application/json" };
  const call = (path, options = {}) => fetcher(new URL(path, baseUrl), { ...options, headers, signal: AbortSignal.timeout(15000) });
  const catalogResponse = await call("/api/templates");
  if (!catalogResponse.ok) throw new Error("staging_fixture_catalog_unavailable");
  const catalog = await catalogResponse.json();
  const rooms = [];
  for (const [key, templateId] of Object.entries(fixtures)) {
    for (const retry of [0, 1]) {
      const roomId = `qa-legacy-${key}-${retry}`;
      let response = await call(`/api/rooms/${roomId}`);
      if (response.status === 404) {
        if (!catalog.items.some(row => row.templateId === templateId && row.currentVersion === "0.1.0")) throw new Error(`staging_fixture_requires_wave2:${roomId}`);
        response = await call("/api/rooms", { method: "POST", body: JSON.stringify({ roomId, templateId, templateVersion: "0.1.0", tenantId: "demo-tenant", name: `Legacy QA ${key}`, status: "disabled", visibility: "unlisted" }) });
      }
      if (!response.ok) throw new Error(`staging_fixture_failed:${roomId}:${response.status}`);
      const room = await response.json();
      if (room.roomId !== roomId || room.templateId !== templateId || room.templateVersion !== "0.1.0" || room.tenantId !== "demo-tenant") throw new Error(`staging_fixture_binding_mismatch:${roomId}`);
      rooms.push({ roomId, templateId, templateVersion: room.templateVersion });
    }
  }
  return { rooms };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  seedStagingTemplateFixtures(process.env.BASE_URL, process.env.STAGING_ADMIN_TOKEN)
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
