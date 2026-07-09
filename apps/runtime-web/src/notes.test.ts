import assert from "node:assert/strict";
import test from "node:test";

import { nextNotesSaveState, parseSafeMarkdown } from "./notes.js";

test("notes autosave state tracks pending saved and failed transitions", () => {
  assert.equal(nextNotesSaveState("idle", "load"), "loading");
  assert.equal(nextNotesSaveState("loading", "load_ok"), "ready");
  assert.equal(nextNotesSaveState("ready", "edit"), "pending");
  assert.equal(nextNotesSaveState("pending", "save_start"), "saving");
  assert.equal(nextNotesSaveState("saving", "save_ok"), "saved");
  assert.equal(nextNotesSaveState("saving", "save_failed"), "failed");
});

test("safe markdown parser preserves unsafe html as text blocks", () => {
  const blocks = parseSafeMarkdown("# Plan\n\n- keep notes\n<script>alert(1)</script>\n\n```\n<b>code</b>\n```");

  assert.deepEqual(blocks, [
    { type: "heading", level: 1, text: "Plan" },
    { type: "listItem", text: "keep notes" },
    { type: "paragraph", text: "<script>alert(1)</script>" },
    { type: "code", text: "<b>code</b>" }
  ]);
});
