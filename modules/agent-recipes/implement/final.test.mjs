import assert from "node:assert/strict";
import { recipeLib } from "../lib/recipe-lib.mjs";
import { portOf } from "../runner/fake.mjs";
import graph from "./graph.mjs";
import { finalItems, finalResult } from "./final.mjs";

const lib = recipeLib(portOf({ all: async () => [] }));

const items = finalItems(lib, "/p/d", ["make test", "echo 'hi'"]);
assert.equal(items.length, 2);
assert.deepEqual(items.map((i) => i.key), ["final-1", "final-2"]);
assert.equal(
  items[0].gate.command,
  "recipe-gate repro " + lib.quote("/p/d") + " --command " + lib.quote("make test") + " --expect pass --id final-1 --in " + lib.quote("/p/d/integration") + " --timeout-ms 3600000",
);
assert.equal(items[1].gate.command.includes(lib.quote("echo 'hi'")), true);
assert.ok(items[1].gate.command.includes("--id final-2"));
for (const i of items) {
  assert.equal(i.big, true);
  assert.equal(i.gate.timeoutMs, 3660000);
}

assert.equal(finalResult([], []), "none");
const good = { structuredOutput: { ok: true } };
assert.equal(finalResult(["a", "b"], [good, good]), "pass");
assert.equal(finalResult(["a", "b"], [good, { structuredOutput: { ok: false, reason: "exit 1" } }]), "fail: b: exit 1");
assert.equal(finalResult(["a", "b"], [{ ok: false, error: "boom" }, { structuredOutput: { ok: false, reason: "r" } }]), "fail: a: boom; b: r");
assert.equal(finalResult(["a"], []), "fail: a: did not run");

assert.equal(typeof graph, "function");
