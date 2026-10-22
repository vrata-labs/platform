import test from "node:test";
import assert from "node:assert/strict";
import { createRoomPluginStatusView, type RoomPluginStatusRow } from "./status-view.js";

function fixture() {
  const root = { hidden: true }, nodes: Array<{ textContent: string }> = []; let writes = 0;
  const view = createRoomPluginStatusView({ root, document: { createElement: () => ({ textContent: "", className: "" }) } as unknown as Document,
    list: { replaceChildren: (...children) => { writes++; nodes.splice(0, nodes.length, ...children as unknown as Array<{ textContent: string }>); } } });
  return { view, root, nodes, writes: () => writes };
}
const row = (patch: Partial<RoomPluginStatusRow> = {}): RoomPluginStatusRow => ({ name: "<b>literal name</b>", state: "running", text: "<img onerror=bad> literal", ...patch });
test("plugin statuses are separate literal text with a trusted label, bounded rows and no repeat announcements", () => {
  const h = fixture(); h.view.render([row(), row(), row()]);
  assert.equal(h.root.hidden, false); assert.equal(h.nodes.length, 2);
  assert.equal(h.nodes[0].textContent, "Плагин «<b>literal name</b>»: <img onerror=bad> literal");
  h.view.render([row(), row()]); assert.equal(h.writes(), 1);
});
test("empty strings clear author statuses and no-binding rooms keep the container hidden", () => {
  const h = fixture(); h.view.render([row()]); h.view.render([row({ text: "" })]);
  assert.equal(h.root.hidden, true); assert.equal(h.nodes.length, 0);
  h.view.render([]); assert.equal(h.nodes.length, 0);
});
test("platform failure/suspension does not echo exception text, and unsupported seating is explicit", () => {
  const h = fixture(); h.view.render([row({ state: "failed", text: "private exception" }), row({ seatingUnavailable: true, text: "" })]);
  assert.equal(h.nodes[0].textContent.includes("private exception"), false);
  assert.match(h.nodes[1].textContent, /Automatic seating is not available/);
  h.view.render([row({ state: "suspended", text: "private config" })]); assert.equal(h.nodes[0].textContent.includes("private config"), false);
});
