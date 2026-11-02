import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Execute the real composition callback without booting WebGL, network or XR.
const text = readFileSync(new URL("../apps/runtime-web/src/main.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.ts", text, ts.ScriptTarget.ES2022, true);
const callbacks = [];
function visit(node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(ast) === "onSeatClaimResult") callbacks.push(node.initializer);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(callbacks.length, 1);
const source = ts.transpileModule(`const callback = ${callbacks[0].getText(ast)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }
}).outputText;

function invoke(result, { current = true, cancelled = false } = {}) {
  const calls = [];
  const bindings = {
    isCurrentConnection: () => current,
    roomPluginSeats: { settleClaim: value => calls.push(["settle", value.commandId]) },
    seatingController: { isCancelledClaim: () => cancelled, settleRejectedClaim: () => calls.push(["rejected"]) },
    syncSeatDebugState: () => {}, roomSeatOccupancy: {}, participantId: "self",
    applyAcceptedSeatClaimToOccupancy: () => ({}), clearSeatReclaimRetry: () => {},
    syncSeatStateFromOccupancy: () => calls.push(["ordinary-occupancy-sync"]), setStatus: () => {},
    roomPluginRuntime: { seatingChanged: force => calls.push(["notify", force]) }
  };
  const callback = new Function(...Object.keys(bindings), `${source}\nreturn callback;`)(...Object.values(bindings));
  callback(result);
  return calls;
}
const rejected = { seatId: "seat-a", accepted: false, commandId: "plugin-seat:attempt:1" };

test("a correlated claim rejection forces a post-result seating observation after settlement", () => {
  const calls = invoke(rejected);
  assert.deepEqual(calls.filter(row => row[0] === "notify"), [["notify", true]]);
  assert.ok(calls.findIndex(row => row[0] === "settle") < calls.findIndex(row => row[0] === "notify"));
});

test("a legacy uncorrelated rejection does not force an unchanged snapshot", () => {
  assert.deepEqual(invoke({ seatId: "seat-a", accepted: false }).filter(row => row[0] === "notify"), [["notify", false]]);
});

test("an accepted claim keeps the ordinary authoritative occupancy path", () => {
  const calls = invoke({ ...rejected, accepted: true });
  assert.ok(calls.some(row => row[0] === "ordinary-occupancy-sync"));
  assert.equal(calls.some(row => row[0] === "notify"), false);
});

test("stale connections and cancelled claims cannot force seating delivery", () => {
  assert.deepEqual(invoke(rejected, { current: false }), []);
  assert.equal(invoke(rejected, { cancelled: true }).some(row => row[0] === "notify"), false);
});
