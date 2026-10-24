/**
 * Behaviour tests for the handoff text and parser. Run by `nix flake check`.
 */
import assert from "node:assert/strict";
import { HANDOFF_ACTIONS, handoffPrompt, parseHandoff } from "./handoff.mjs";

assert.equal(parseHandoff("handoff: a done; b left\nrest").line, "handoff: a done; b left");
assert.equal(parseHandoff("\n\n> handoff: x").line, "handoff: x");
assert.equal(parseHandoff("**Handoff:** x").line, "Handoff: x");
assert.equal(parseHandoff("done\nhandoff: x"), null);
assert.equal(parseHandoff(""), null);
assert.equal(parseHandoff(undefined), null);
assert.deepEqual(parseHandoff("handoff: x").unread, []);

const r = parseHandoff(
  "handoff: x\n- unread: a.md, `b.md`\n* Unread: a.md,c.md\nunread: d.md\nunread:\n",
);
assert.deepEqual(r.unread, ["a.md", "b.md", "c.md", "d.md"]);

assert.deepEqual(HANDOFF_ACTIONS, ["commit", "unread", "stop"]);
for (const action of HANDOFF_ACTIONS) {
  const p = handoffPrompt(action, { output: "/o/out.md", tokens: 1234 });
  assert.match(p, /1234/);
  assert.match(p, /\/o\/out\.md/);
  assert.match(p, /handoff: </);
  assert.match(handoffPrompt(action, { tokens: 5 }), /reply as text/);
  assert.equal(/git/.test(p), action === "commit");
  assert.equal(/unread:/.test(p), action === "unread");
}
assert.throws(() => handoffPrompt("nope", { output: "x", tokens: 1 }), /unknown/);
