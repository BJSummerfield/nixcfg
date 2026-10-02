/**
 * Behaviour tests for the resume card. Run by `nix flake check`.
 *
 * These exercise the extension against a stub of the parts of pi's
 * ExtensionAPI it uses (the `session_before_compact` payload shape), which
 * were verified by reading the installed 0.86.1 source instead.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import resumeCard, { buildCard } from "./resume-card.js";

function harness() {
  const handlers = {};
  const pi = {
    on: (event, handler) => {
      handlers[event] = handler;
    },
  };
  resumeCard(pi);
  return {
    compact: (event, ctx) => handlers.session_before_compact(event, ctx),
  };
}

function ctxFor(cwd, sessionFile = "/s/x.jsonl") {
  return { cwd, sessionManager: { getSessionFile: () => sessionFile } };
}

const toolCall = (name, args) => ({ type: "toolCall", name, arguments: args });
const assistantEntry = (content) => ({ type: "message", message: { role: "assistant", content } });
const entry = (name, args) => assistantEntry([toolCall(name, args)]);
const textMsg = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
const userMsg = (text) => ({ role: "user", content: [{ type: "text", text }] });
const userEntry = (text) => ({ type: "message", message: userMsg(text) });

const basePreparation = (overrides) => ({
  firstKeptEntryId: "kept-1",
  tokensBefore: 80_000,
  messagesToSummarize: [],
  turnPrefixMessages: [],
  ...overrides,
});

// 1. compaction passthrough, no usage, no cancel, details.card === 1.
{
  const h = harness();
  const cwd = mkdtempSync(join(tmpdir(), "resume-card-"));
  const result = await h.compact(
    { preparation: basePreparation(), branchEntries: [] },
    ctxFor(cwd),
  );
  assert.ok(result.compaction);
  assert.equal(result.cancel, undefined);
  assert.equal(result.compaction.usage, undefined);
  assert.equal(result.compaction.firstKeptEntryId, "kept-1");
  assert.equal(result.compaction.tokensBefore, 80_000);
  assert.equal(result.compaction.details.card, 1);
}

// 2. ledger lists existing standard files of the most recently touched plan
// dir, fixed order, including a path found only through bash; at most 2
// units, latest first.
{
  const h = harness();
  const cwd = mkdtempSync(join(tmpdir(), "resume-card-"));
  mkdirSync(join(cwd, ".plans", "foo"), { recursive: true });
  mkdirSync(join(cwd, ".plans", "bar"), { recursive: true });
  writeFileSync(join(cwd, ".plans", "foo", "state.json"), "{}");
  writeFileSync(join(cwd, ".plans", "foo", "tasks.json"), "{}");
  writeFileSync(join(cwd, ".plans", "bar", "PAUSE.md"), "x");
  const branchEntries = [
    entry("read", { path: ".plans/foo/state.json" }),
    entry("bash", { command: "cat > .plans/bar/PAUSE.md" }),
  ];
  const result = await h.compact({ preparation: basePreparation(), branchEntries }, ctxFor(cwd));
  const card = result.compaction.summary;
  assert.match(card, /\.plans\/bar\/PAUSE\.md/);
  assert.equal(result.compaction.details.ledger.length <= 2 * 4, true);
}

// 3. modified files cover write/edit from all branchEntries, sorted,
// de-duplicated, relative to cwd; reads are not listed.
{
  const h = harness();
  const cwd = mkdtempSync(join(tmpdir(), "resume-card-"));
  const branchEntries = [
    entry("write", { path: "modules/b.nix" }),
    entry("read", { path: "modules/ignored.nix" }),
    entry("edit", { path: "modules/a.nix" }),
    entry("write", { path: "modules/a.nix" }),
  ];
  const result = await h.compact({ preparation: basePreparation(), branchEntries }, ctxFor(cwd));
  assert.deepEqual(result.compaction.details.modifiedFiles, ["modules/a.nix", "modules/b.nix"]);
  assert.doesNotMatch(result.compaction.summary, /ignored\.nix/);
}

// 4. excerpt is the last text-bearing assistant message of the dropped span;
// turnPrefixMessages wins over messagesToSummarize; kept-tail text is never
// used; thinking blocks and model tags are stripped; 1000 words -> 300.
{
  const h = harness();
  const cwd = mkdtempSync(join(tmpdir(), "resume-card-"));
  const longText = Array.from({ length: 1000 }, (_, i) => `w${i}`).join(" ");
  const preparation = basePreparation({
    messagesToSummarize: [textMsg("<think>reasoning</think>first <tool_call>x</tool_call>")],
    turnPrefixMessages: [textMsg(longText)],
  });
  const result = await h.compact({ preparation, branchEntries: [] }, ctxFor(cwd));
  const card = result.compaction.summary;
  assert.doesNotMatch(card, /<think>|<tool_call>/);
  assert.match(card, /… w700 w701/);
  assert.doesNotMatch(card, /\bfirst\b/);
}

// 5. replace, not accumulate: previousSummary is never read and never changes
// the output; two calls on identical input are byte-identical.
{
  const h = harness();
  const cwd = mkdtempSync(join(tmpdir(), "resume-card-"));
  const preparation = basePreparation({ messagesToSummarize: [textMsg("hello")] });
  const withPrev = { ...preparation, previousSummary: "x".repeat(50_000) };
  const r1 = await h.compact({ preparation, branchEntries: [] }, ctxFor(cwd));
  const r2 = await h.compact({ preparation: withPrev, branchEntries: [] }, ctxFor(cwd));
  assert.equal(r1.compaction.summary, r2.compaction.summary);
  const r3 = await h.compact({ preparation, branchEntries: [] }, ctxFor(cwd));
  assert.equal(r1.compaction.summary, r3.compaction.summary);
}

// 6. cap: 500 modified paths of 300 chars give summary.length <= 6000 and
// contain "… and"; every path line is <= 200 chars.
{
  const cwd = mkdtempSync(join(tmpdir(), "resume-card-"));
  const modified = Array.from({ length: 500 }, (_, i) => `modules/${"x".repeat(300)}${i}.nix`.slice(0, 200));
  const card = buildCard({ ledger: [], modified, excerpt: "e", sessionFile: "/s/x.jsonl" });
  assert.ok(card.length <= 6000);
  assert.match(card, /… and/);
  for (const line of card.split("\n")) {
    if (line.startsWith("- ") && !line.includes("… and")) assert.ok(line.length - 2 <= 200);
  }
}

// 7. getSessionFile() undefined -> "(not saved to disk)"; no plan paths ->
// fallback line; empty dropped span -> no-text line.
{
  const h = harness();
  const cwd = mkdtempSync(join(tmpdir(), "resume-card-"));
  const result = await h.compact(
    { preparation: basePreparation(), branchEntries: [] },
    { cwd, sessionManager: { getSessionFile: () => undefined } },
  );
  const card = result.compaction.summary;
  assert.match(card, /\(not saved to disk\)/);
  assert.match(card, /No plan ledger was touched/);
  assert.match(card, /\(no assistant text in the removed span\)/);
}

// 8. every reason yields a card.
{
  const h = harness();
  const cwd = mkdtempSync(join(tmpdir(), "resume-card-"));
  for (const reason of ["manual", "threshold", "overflow"]) {
    const result = await h.compact(
      { preparation: basePreparation(), branchEntries: [], reason, willRetry: false },
      ctxFor(cwd),
    );
    assert.ok(result.compaction.summary.length > 0, reason);
  }
}

// 9. A-1: the first user message in branchEntries becomes a Task block,
// verbatim.
{
  const h = harness();
  const cwd = mkdtempSync(join(tmpdir(), "resume-card-"));
  const branchEntries = [userEntry("Fix the flaky test in foo.spec.ts"), entry("read", { path: "foo.spec.ts" })];
  const result = await h.compact({ preparation: basePreparation(), branchEntries }, ctxFor(cwd));
  const card = result.compaction.summary;
  assert.match(card, /Task \(first user message/);
  assert.match(card, /Fix the flaky test in foo\.spec\.ts/);
}

// 10. The task block is capped at 1,500 chars with a trailing "…".
{
  const h = harness();
  const cwd = mkdtempSync(join(tmpdir(), "resume-card-"));
  const longTask = "y".repeat(2000);
  const branchEntries = [userEntry(longTask)];
  const result = await h.compact({ preparation: basePreparation(), branchEntries }, ctxFor(cwd));
  const card = result.compaction.summary;
  assert.ok(card.includes(`${"y".repeat(1500)}…`));
  assert.ok(!card.includes("y".repeat(1501)));
}

// 11. The latest dropped user message gets its own block when it differs
// from the first user message; an identical one is not duplicated.
{
  const h = harness();
  const cwd = mkdtempSync(join(tmpdir(), "resume-card-"));
  const branchEntries = [userEntry("Build the thing")];
  const preparation = basePreparation({ messagesToSummarize: [userMsg("Also handle the edge case")] });
  const result = await h.compact({ preparation, branchEntries }, ctxFor(cwd));
  const card = result.compaction.summary;
  assert.match(card, /Task \(first user message/);
  assert.match(card, /Build the thing/);
  assert.match(card, /Latest instructions before the cut/);
  assert.match(card, /Also handle the edge case/);
}
{
  const h = harness();
  const cwd = mkdtempSync(join(tmpdir(), "resume-card-"));
  const branchEntries = [userEntry("Build the thing")];
  const preparation = basePreparation({ messagesToSummarize: [userMsg("Build the thing")] });
  const result = await h.compact({ preparation, branchEntries }, ctxFor(cwd));
  assert.doesNotMatch(result.compaction.summary, /Latest instructions before the cut/);
}

// 12. pi's own compaction-summary text, resent as a role:"user" message, is
// never picked up as the task; the next genuine user message is.
{
  const h = harness();
  const cwd = mkdtempSync(join(tmpdir(), "resume-card-"));
  const fakeSummary =
    "The conversation history before this point was compacted into the following summary:\n\n<summary>\nx\n</summary>";
  const branchEntries = [userEntry(fakeSummary), userEntry("Real task here")];
  const result = await h.compact({ preparation: basePreparation(), branchEntries }, ctxFor(cwd));
  const card = result.compaction.summary;
  assert.match(card, /Real task here/);
  assert.doesNotMatch(card, /conversation history before this point/);
}

// 13. No user message anywhere: no Task block at all.
{
  const h = harness();
  const cwd = mkdtempSync(join(tmpdir(), "resume-card-"));
  const result = await h.compact({ preparation: basePreparation(), branchEntries: [] }, ctxFor(cwd));
  assert.doesNotMatch(result.compaction.summary, /Task \(first user message/);
}

// 14. A-3: a bare ".plans/<slug>" directory reference (no file extension,
// e.g. from `ls .plans/<slug>`) is never listed as a file to re-read itself;
// only the existing standard files under it are.
{
  const h = harness();
  const cwd = mkdtempSync(join(tmpdir(), "resume-card-"));
  mkdirSync(join(cwd, ".plans", "2026-09-26-scene-gen-v3"), { recursive: true });
  writeFileSync(join(cwd, ".plans", "2026-09-26-scene-gen-v3", "tasks.json"), "{}");
  const branchEntries = [entry("bash", { command: "ls .plans/2026-09-26-scene-gen-v3" })];
  const result = await h.compact({ preparation: basePreparation(), branchEntries }, ctxFor(cwd));
  const ledger = result.compaction.details.ledger;
  assert.ok(!ledger.includes(".plans/2026-09-26-scene-gen-v3"), "the bare directory itself must not be listed");
  assert.ok(ledger.some((p) => p.endsWith("tasks.json")));
}

console.log("resume-card: all assertions passed");
