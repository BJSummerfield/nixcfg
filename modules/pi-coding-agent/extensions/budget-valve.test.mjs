/**
 * Behaviour tests for the budget valve, run with `node`.
 *
 * These exercise the extension against a stub of the parts of pi's
 * ExtensionAPI it uses; they cannot prove pi's own semantics (that a
 * `followUp` or `steer` message triggers a turn in the same session).
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import budgetValve, { readOptions } from "./budget-valve.js";

function harness(options) {
  const handlers = {};
  const sent = [];
  const pi = {
    on: (event, handler) => {
      handlers[event] = handler;
    },
    sendMessage: async (message, opts) => {
      sent.push({ message, options: opts });
    },
  };
  budgetValve(pi, options);
  return {
    sent,
    handlers,
    turnEnd: (message, ctx) => handlers.turn_end({ type: "turn_end", message }, ctx),
    toolExecutionEnd: (event) => handlers.tool_execution_end({ type: "tool_execution_end", ...event }),
    sessionCompact: () => handlers.session_compact({ type: "session_compact" }),
    toolCall: (event = {}) => handlers.tool_call({ type: "tool_call", ...event }),
  };
}

const assistant = (usage, stopReason = "stop", content) => ({
  role: "assistant",
  stopReason,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...usage },
  ...(content ? { content } : {}),
});

const toolCalls = [{ type: "toolCall" }];

// A truncated turn is recovered with a followUp, once; a second cut-off ends
// with a tool-permitting steer; a third sends nothing (sent.length stays 2).
{
  const h = harness();
  await h.turnEnd(assistant({ totalTokens: 30_000 }, "length"));
  await h.turnEnd(assistant({ totalTokens: 30_000 }, "length"));
  await h.turnEnd(assistant({ totalTokens: 30_000 }, "length"));
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[0].message.customType, "budget-valve-truncated");
  assert.equal(h.sent[0].options.deliverAs, "followUp");
  assert.equal(h.sent[0].options.triggerTurn, true);
  assert.match(h.sent[0].message.content[0].text, /one tool call per section/);
  assert.equal(h.sent[1].message.customType, "budget-valve-final");
  assert.equal(h.sent[1].options.deliverAs, "steer");
  assert.match(h.sent[1].message.content[0].text, /FAILED: output limit/);
}

// Context size is pi's business: no turn is interrupted for being large, and
// nothing is ever aborted.
{
  const h = harness();
  let aborted = 0;
  const ctx = { abort: () => (aborted += 1) };
  await h.turnEnd(assistant({ totalTokens: 70_000 }), ctx);
  await h.turnEnd(assistant({ totalTokens: 90_000 }, "toolUse"), ctx);
  await h.turnEnd(assistant({ totalTokens: 95_000 }, "toolUse"), ctx);
  assert.equal(h.sent.length, 0, "no handoff request at any size");
  assert.equal(aborted, 0, "no abort at any size");
}

// A child compacts like any other session: the valve does not listen for it
// through the compaction hook.
{
  const h = harness();
  assert.equal(h.handlers.session_before_compact, undefined);
}

// No recovery when the window is nearly full: the recovery turn would inherit the
// same dead ceiling. The run is left to pi, not aborted. The final notice (state 1)
// has no headroom check.
{
  const h = harness();
  let aborted = 0;
  const ctx = {
    abort: () => (aborted += 1),
    getContextUsage: () => ({ contextWindow: 98_304, tokens: 93_000 }),
  };
  await h.turnEnd(assistant({ totalTokens: 93_000 }, "length"), ctx);
  assert.equal(h.sent.length, 0);
  assert.equal(aborted, 0);
}

// A skipped first recovery does not use a state.
{
  const h = harness();
  const full = { getContextUsage: () => ({ contextWindow: 98_304, tokens: 93_000 }) };
  const roomy = { getContextUsage: () => ({ contextWindow: 98_304, tokens: 40_000 }) };
  await h.turnEnd(assistant({ totalTokens: 93_000 }, "length"), full);
  await h.turnEnd(assistant({ totalTokens: 40_000 }, "length"), roomy);
  assert.equal(h.sent.length, 1);
}

// Non-assistant turn_end payloads are ignored.
{
  const h = harness();
  await h.turnEnd({ role: "user", stopReason: "length", usage: { totalTokens: 30_000 } });
  await h.turnEnd(undefined);
  assert.equal(h.sent.length, 0);
}

// A "length" stop that pi would also treat as recoverable overflow
// (output short of the model's unclamped maxTokens, near a full window) is
// already covered by the state-0 headroom gate above: a queued valve message
// drains before agent_end, so whichever of the two acts first simply
// pre-empts the other, and there is no double handling to guard against. A
// near-full ctx (contextWindow and tokens close to full, as the clamp
// produces) confirms state 0 sends nothing here, same as the plain
// near-full-window case already covered.
{
  const h = harness();
  const ctx = { getContextUsage: () => ({ contextWindow: 98_304, tokens: 94_208 }) };
  await h.turnEnd(assistant({ output: 16_384, totalTokens: 94_208 }, "length"), ctx);
  assert.equal(h.sent.length, 0);
}

// Compaction thrash: three session_compact events with no intervening edit or
// write end the run with a tool-blocking steer; a fourth sends nothing more.
{
  const h = harness();
  await h.sessionCompact();
  await h.sessionCompact();
  assert.equal(h.sent.length, 0);
  await h.sessionCompact();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.customType, "budget-valve-thrash");
  assert.equal(h.sent[0].options.deliverAs, "steer");
  assert.match(h.sent[0].message.content[0].text, /FAILED: compaction thrash/);
  await h.sessionCompact();
  assert.equal(h.sent.length, 1);
}

// A successful edit/write between compactions resets the count; an isError
// write does not; a read does not.
{
  const h = harness();
  await h.sessionCompact();
  await h.sessionCompact();
  await h.toolExecutionEnd({ toolName: "write", isError: false });
  await h.sessionCompact();
  await h.sessionCompact();
  assert.equal(h.sent.length, 0, "the reset absorbed the first two");
  await h.toolExecutionEnd({ toolName: "write", isError: true });
  await h.toolExecutionEnd({ toolName: "read", isError: false });
  await h.sessionCompact();
  assert.equal(h.sent.length, 1, "neither the failed write nor the read reset the count");
}

// Before the thrash ending, tool_call is unblocked. After it: write and edit
// pass for two tool-bearing turns while bash and read are blocked without
// terminating, then every call is blocked with terminate.
{
  const h = harness();
  assert.equal(h.toolCall(), undefined);
  await h.sessionCompact();
  await h.sessionCompact();
  await h.sessionCompact();
  const text = h.sent[0].message.content[0].text;
  assert.match(text, /`FAILED: compaction thrash` at the top of the output file your task names/);
  assert.match(text, /then reply/);
  for (const turn of [0, 1]) {
    assert.equal(h.toolCall({ toolName: "write", input: { path: "x" } }), undefined, `write turn ${turn + 1}`);
    assert.equal(h.toolCall({ toolName: "edit", input: { path: "x" } }), undefined, `edit turn ${turn + 1}`);
    for (const event of [
      { toolName: "bash", input: { command: "git add -A" } },
      { toolName: "read", input: { path: "x" } },
    ]) {
      const r = h.toolCall(event);
      assert.equal(r.block, true, JSON.stringify(event));
      assert.equal(r.terminate, false, JSON.stringify(event));
      assert.match(r.reason, /FAILED: compaction thrash/);
    }
    await h.turnEnd(assistant({}, "stop", [{ type: "toolCall" }]));
  }
  for (const event of [
    { toolName: "write", input: { path: "x" } },
    { toolName: "edit", input: { path: "x" } },
    { toolName: "bash", input: { command: "git add -A" } },
    { toolName: "read", input: { path: "x" } },
  ]) {
    const r = h.toolCall(event);
    assert.equal(r.block, true, JSON.stringify(event));
    assert.equal(r.terminate, true, `after two tool-bearing turns, ${JSON.stringify(event)}`);
  }
}

// After the thrash ending, a length turn sends no further valve message.
{
  const h = harness();
  await h.sessionCompact();
  await h.sessionCompact();
  await h.sessionCompact();
  assert.equal(h.sent.length, 1);
  await h.turnEnd(assistant({ totalTokens: 30_000 }, "length"));
  assert.equal(h.sent.length, 1);
}

// No options means no handoff even at a huge context, and tool calls stay
// unblocked. The default argument runs readOptions() with the real config
// paths and finds nothing here: no budget-valve.json sits next to the file,
// and these tests never install one in the agent home directory.
{
  const h = harness();
  await h.turnEnd(assistant({ totalTokens: 200_000 }, "stop", toolCalls));
  assert.equal(h.sent.length, 0, "no handoff without a budget, at any size");
  assert.equal(h.toolCall({ toolName: "read", input: { path: "x" } }), undefined);
}

// The config is read from the given paths, in order: a valid handoffTokens
// from the first readable path is picked up and a tool-bearing turn at that
// budget hands off; a missing, unparsable or non-positive file is skipped
// or means no handoff. The tests point readOptions at a temp directory.
{
  const dir = mkdtempSync(join(tmpdir(), "budget-valve-test-"));
  const p = join(dir, "budget-valve.json");
  const run = async (file, budget, expectSteer) => {
    if (file === undefined) {
      if (existsSync(p)) unlinkSync(p);
    } else {
      writeFileSync(p, file);
    }
    const sent = [];
    const handlers = {};
    budgetValve(
      { on: (event, handler) => (handlers[event] = handler), sendMessage: async (message, opts) => sent.push({ message, options: opts }) },
      readOptions([p]),
    );
    await handlers.turn_end({ type: "turn_end", message: assistant({ totalTokens: budget }, "stop", toolCalls) });
    assert.equal(sent.length, expectSteer ? 1 : 0, `file ${file}`);
    if (expectSteer) {
      assert.equal(sent[0].message.customType, "budget-valve-handoff", `file ${file}`);
      assert.match(sent[0].message.content[0].text, /about 60000 tokens/);
    }
  };
  await run('{"handoffTokens": 60000}', 60_000, true);
  await run(undefined, 90_000, false);
  await run("not json", 90_000, false);
  await run('{"handoffTokens": 0}', 90_000, false);
  await run('{"handoffTokens": -5}', 90_000, false);
  await run('{"handoffTokens": "60000"}', 90_000, false);
  await run("{}", 90_000, false);
  unlinkSync(p);
}

// readOptions skips a missing, unparsable or non-positive file and uses the
// next path, so the config is found wherever pi loads the extension from.
{
  const dir = mkdtempSync(join(tmpdir(), "budget-valve-test-"));
  const p1 = join(dir, "first.json");
  const p2 = join(dir, "second.json");
  const path = (n) => join(dir, n);
  assert.equal(readOptions([path("missing.json"), path("missing-2.json")]), undefined);
  writeFileSync(p1, "not json");
  writeFileSync(p2, '{"handoffTokens": 60000}');
  assert.deepEqual(readOptions([p1, p2]), { handoffTokens: 60_000 }, "unparsable first path falls through");
  writeFileSync(p1, '{"handoffTokens": 0}');
  assert.deepEqual(readOptions([p1, p2]), { handoffTokens: 60_000 }, "non-positive first path falls through");
  writeFileSync(p1, '{"handoffTokens": 40000}');
  assert.deepEqual(readOptions([p1, p2]), { handoffTokens: 40_000 }, "the first readable valid path wins");
  unlinkSync(p1);
  unlinkSync(p2);
}

// A usage without totalTokens counts input, output, cache reads and writes:
// a context that lives mostly in the cache still reaches the budget.
{
  const h = harness({ handoffTokens: 60_000 });
  await h.turnEnd(assistant({ input: 30_000, output: 1_000, cacheRead: 25_000, cacheWrite: 4_000 }, "stop", toolCalls), undefined);
  assert.equal(h.sent.length, 1, "the cache fields count toward the budget");
  assert.match(h.sent[0].message.content[0].text, /about 60000 tokens/);
}

// A chain separator the parser must not swallow: `;` (and a bare newline)
// ends a segment, so a git command that chains onto something else is
// blocked.
{
  const h = harness({ handoffTokens: 60_000 });
  await h.turnEnd(assistant({ totalTokens: 60_000 }, "stop", toolCalls));
  for (const command of ["git commit ; rm -rf /", "git add -A\nrm x"]) {
    const r = h.toolCall({ toolName: "bash", input: { command } });
    assert.equal(r.block, true, JSON.stringify(command));
    assert.equal(r.terminate, undefined, JSON.stringify(command));
    assert.match(r.reason, /handing off/);
  }
  const r = h.toolCall({ toolName: "bash", input: { command: "git add -A && git status" } });
  assert.equal(r, undefined, "an all-git chain still passes");
}

// `git -C <path> <sub>` takes the subcommand after the path, so a
// `git -C` with nothing after it is never safe.
{
  const h = harness({ handoffTokens: 60_000 });
  await h.turnEnd(assistant({ totalTokens: 60_000 }, "stop", toolCalls));
  const allowed = ["git -C repo commit -m x", "git -C repo add -A"];
  for (const command of allowed) {
    assert.equal(h.toolCall({ toolName: "bash", input: { command } }), undefined, JSON.stringify(command));
  }
  for (const command of ["git -C diff", "git -C /repo"]) {
    const r = h.toolCall({ toolName: "bash", input: { command } });
    assert.equal(r.block, true, JSON.stringify(command));
    assert.equal(r.terminate, undefined, JSON.stringify(command));
    assert.match(r.reason, /handing off/);
  }
}

// The allowlist names every subcommand the handoff may run: `show` and
// `rev-parse` pass, and anything else is blocked.
{
  const h = harness({ handoffTokens: 60_000 });
  await h.turnEnd(assistant({ totalTokens: 60_000 }, "stop", toolCalls));
  for (const command of ["git show HEAD", "git rev-parse HEAD"]) {
    assert.equal(h.toolCall({ toolName: "bash", input: { command } }), undefined, JSON.stringify(command));
  }
  for (const command of ["git checkout -b x", "git fetch", "git -C repo push"]) {
    const r = h.toolCall({ toolName: "bash", input: { command } });
    assert.equal(r.block, true, JSON.stringify(command));
    assert.equal(r.terminate, undefined, JSON.stringify(command));
    assert.match(r.reason, /handing off/);
  }
}

// `cd` with more than one argument is not a plain directory change.
{
  const h = harness({ handoffTokens: 60_000 });
  await h.turnEnd(assistant({ totalTokens: 60_000 }, "stop", toolCalls));
  for (const command of ["cd a b", "cd -P a b", "cd a b && git push", "cd a b && git commit -m x"]) {
    const r = h.toolCall({ toolName: "bash", input: { command } });
    assert.equal(r.block, true, JSON.stringify(command));
    assert.equal(r.terminate, undefined, JSON.stringify(command));
    assert.match(r.reason, /handing off/);
  }
}

// Below the budget a tool-bearing turn sends nothing and unblocks nothing.
{
  const h = harness({ handoffTokens: 60_000 });
  await h.turnEnd(assistant({ totalTokens: 59_999 }, "stop", toolCalls));
  assert.equal(h.sent.length, 0);
  assert.equal(h.toolCall({ toolName: "read", input: { path: "x" } }), undefined);
}

// At the budget a tool-bearing turn sends exactly one handoff steer naming
// the token count; a second over-budget turn sends nothing more.
{
  const h = harness({ handoffTokens: 60_000 });
  await h.turnEnd(assistant({ totalTokens: 60_000 }, "stop", toolCalls));
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.customType, "budget-valve-handoff");
  assert.equal(h.sent[0].options.deliverAs, "steer");
  assert.equal(h.sent[0].options.triggerTurn, true);
  const text = h.sent[0].message.content[0].text;
  assert.match(text, /about 60000 tokens/);
  assert.match(text, /handoff: <what is done; what is left>/);
  assert.match(text, /`## Done`, `## Left` and `## Watch for`/);
  assert.match(text, /From now on only writing files and git are allowed/);
  await h.turnEnd(assistant({ totalTokens: 70_000 }, "stop", toolCalls));
  assert.equal(h.sent.length, 1, "a second over-budget turn sends no second steer");
}

// A final reply without tool calls never hands off, even over the budget.
{
  const h = harness({ handoffTokens: 60_000 });
  await h.turnEnd(assistant({ totalTokens: 90_000 }, "stop"));
  assert.equal(h.sent.length, 0, "no tool calls, no handoff");
}

// During the handoff, writes and safe git commands pass to any path;
// everything else is blocked with a reason naming what is allowed, without
// terminating.
{
  const h = harness({ handoffTokens: 60_000 });
  await h.turnEnd(assistant({ totalTokens: 60_000 }, "stop", toolCalls));
  assert.equal(h.sent.length, 1);
  const allowed = [
    { toolName: "write", input: { path: "/var/tmp/note.md" } },
    { toolName: "edit", input: { path: "/var/tmp/note.md" } },
    { toolName: "bash", input: { command: "git commit -m x" } },
    { toolName: "bash", input: { command: "git add -A" } },
  ];
  for (const event of allowed) assert.equal(h.toolCall(event), undefined, JSON.stringify(event));
  const blocked = [
    { toolName: "read", input: { path: "x" } },
    { toolName: "bash", input: { command: "ls" } },
    { toolName: "bash", input: { command: "git push" } },
    { toolName: "bash", input: { command: "git commit -m x | cat" } },
    { toolName: "bash", input: { command: "git -c user.name=x commit" } },
    { toolName: "bash", input: { command: "git add -A; echo done" } },
  ];
  for (const event of blocked) {
    const r = h.toolCall(event);
    assert.equal(r.block, true, JSON.stringify(event));
    assert.equal(r.terminate, undefined, JSON.stringify(event));
    assert.match(r.reason, /handing off/);
    assert.match(r.reason, /git/);
  }
}

// The fifth tool-bearing turn's calls are terminal: after the steer, four
// tool-bearing turns may still call tools, then every call is blocked with
// terminate.
{
  const h = harness({ handoffTokens: 60_000 });
  await h.turnEnd(assistant({ totalTokens: 60_000 }, "stop", toolCalls));
  for (let i = 0; i < 3; i += 1) await h.turnEnd(assistant({}, "stop", toolCalls));
  const before = h.toolCall({ toolName: "write", input: { path: "x" } });
  assert.equal(before, undefined, "the fourth tool-bearing turn's calls still pass");
  await h.turnEnd(assistant({}, "stop", toolCalls));
  const r = h.toolCall({ toolName: "write", input: { path: "x" } });
  assert.equal(r.block, true);
  assert.equal(r.terminate, true, "after four tool-bearing turns every call is terminal");
}

// Only tool-bearing turns count toward the handoff turn limit: text-only
// turns interleaved between them never end the run early.
{
  const h = harness({ handoffTokens: 60_000 });
  await h.turnEnd(assistant({ totalTokens: 60_000 }, "stop", toolCalls));
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.customType, "budget-valve-handoff");
  for (let i = 0; i < 3; i += 1) {
    await h.turnEnd(assistant({}, "stop", toolCalls));
    await h.turnEnd(assistant({}, "stop"));
  }
  assert.equal(h.toolCall({ toolName: "write", input: { path: "x" } }), undefined, "only three tool-bearing turns have passed");
  await h.turnEnd(assistant({}, "stop", toolCalls));
  await h.turnEnd(assistant({}, "stop"));
  const r = h.toolCall({ toolName: "write", input: { path: "x" } });
  assert.equal(r.block, true);
  assert.equal(r.terminate, true, "the text-only turns never counted");
}

// The compaction-thrash stop does not start during a handoff: however many
// compactions happen, no thrash message is sent.
{
  const h = harness({ handoffTokens: 60_000 });
  await h.turnEnd(assistant({ totalTokens: 60_000 }, "stop", toolCalls));
  await h.sessionCompact();
  await h.sessionCompact();
  await h.sessionCompact();
  await h.sessionCompact();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.customType, "budget-valve-handoff");
}

// Truncation recovery stays on during a handoff.
{
  const h = harness({ handoffTokens: 60_000 });
  await h.turnEnd(assistant({ totalTokens: 60_000 }, "stop", toolCalls));
  await h.turnEnd(assistant({ totalTokens: 61_000 }, "length", toolCalls));
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].message.customType, "budget-valve-truncated");
  assert.equal(h.sent[1].options.deliverAs, "followUp");
}

console.log("budget-valve: all assertions passed");
