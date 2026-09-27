import assert from "node:assert/strict";
import test from "node:test";
import { mountSessionUpgradeUi } from "./session-upgrade-ui.js";
import { createSessionUpgradeGate } from "./session-upgrade.js";

test("a throwing local teardown still shows the migration dialog and preserves its draft", () => {
  class Element {
    textContent = "";
    hidden = false;
    disabled = false;
    open = false;
    value = "";
    parentElement: Element | null = null;
    onclick: (() => void) | null = null;
    append() {}
    replaceChildren() {}
    addEventListener() {}
    removeEventListener() {}
    focus() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
  }
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  element("session-upgrade-drafts").parentElement = new Element();
  const values = new Map<string, string>();
  const gate = createSessionUpgradeGate();
  const ui = mountSessionUpgradeUi({
    gate, roomId: "room", buildId: "build",
    document: { getElementById: element, createElement: () => new Element() } as unknown as Document,
    storage: () => ({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key) }),
    getUnsavedNote: () => ({ scope: "shared", content: "unsaved text" }),
    stopSession: () => { throw new Error("private cleanup detail"); },
    reload() {}, download() {}, confirmDiscard: () => false
  });
  assert.doesNotThrow(() => gate.require("identity_upgrade_required"));
  assert.equal(element("session-upgrade-dialog").open, true);
  assert.equal(element("session-upgrade-drafts").hidden, false);
  assert.match(element("session-upgrade-message").textContent, /Some local cleanup failed/);
  assert.ok(!element("session-upgrade-message").textContent.includes("private cleanup detail"));
  assert.ok([...values.values()].some(value => value.includes("unsaved text")));
  ui.dispose();
});
