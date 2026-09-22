import assert from "node:assert/strict";
import test from "node:test";
import { seedStagingTemplateFixtures } from "./seed-staging-template-fixtures.mjs";

test("legacy regression fixtures are created only before activation and retained by exact binding", async () => {
  const rows = new Map();
  let active = false;
  let writes = 0;
  const fetcher = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === "/api/templates") return Response.json({ items: active ? [{ templateId: "meeting-room-basic", currentVersion: "2.0.0" }] : ["meeting-room-basic", "showroom-basic", "personal-workspace-basic"].map(templateId => ({ templateId, currentVersion: "0.1.0" })) });
    assert.equal(options.headers["x-vrata-admin-token"], "fixture-test");
    if (options.method === "POST") {
      const room = JSON.parse(options.body);
      assert.equal(room.status, "disabled"); assert.equal(room.visibility, "unlisted");
      rows.set(room.roomId, room); writes++;
      return Response.json(room, { status: 201 });
    }
    const row = rows.get(path.split("/").pop());
    return row ? Response.json(row) : new Response("missing", { status: 404 });
  };
  const seeded = await seedStagingTemplateFixtures("https://stage.example", "fixture-test", fetcher);
  assert.equal(seeded.rooms.length, 28);
  assert.equal(writes, 28);
  active = true;
  assert.deepEqual(await seedStagingTemplateFixtures("https://stage.example", "fixture-test", fetcher), seeded);
  assert.equal(writes, 28);
  const id = seeded.rooms[0].roomId;
  rows.get(id).templateVersion = "2.0.0";
  await assert.rejects(() => seedStagingTemplateFixtures("https://stage.example", "fixture-test", fetcher), /binding_mismatch/);
  rows.delete(id);
  await assert.rejects(() => seedStagingTemplateFixtures("https://stage.example", "fixture-test", fetcher), /requires_wave2/);
  assert.equal(writes, 28);
});
