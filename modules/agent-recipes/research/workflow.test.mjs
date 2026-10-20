/**
 * Dry run of the research workflow script against a fake `runs`. Run by
 * `nix flake check`. It proves the script's own logic (angles, ranking and
 * capping, gate commands, retry, split, sizing, review, gap round, receipt);
 * pi-subagents' semantics are not exercised, and byte counts are the fake
 * gate's, not real extracts.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("./workflow.js", import.meta.url), "utf8");
assert.ok(!/\basync\b/.test(source), "workflow scripts may not define async functions");
assert.ok(!/setTimeout/.test(source), "the sandbox has no setTimeout");

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = (runs, args) => new AsyncFunction("runs", "args", source)(runs, Object.freeze(args));

const src = (angle, n, kind) => ({ url: `https://example.com/${angle}/${n}`, angle, why: "w", kind });
const ok = (key, structuredOutput) => ({ ok: true, runId: `run-${key}`, structuredOutput });
const failed = (key, error) => ({ ok: false, runId: `run-${key}`, error });
const extractOk = (key, bytes = 50000) => ok(key, { ok: true, bytes, quotes: 3, over_cap: false });
const extractRejected = (key) => ok(key, { ok: false, bytes: 100, quotes: 0, over_cap: false });
const extractOver = (key) => ok(key, { ok: false, bytes: 30000, quotes: 5, over_cap: true });
const urlList = (list) => ({ ok: list.length > 0, urls: list });

function fake(respond) {
  const batches = [];
  return {
    batches,
    items: () => batches.flat(),
    runs: {
      all: async (items) => {
        batches.push(items);
        return items.map((item) => respond(item));
      },
    },
  };
}

const keys = (batches) => batches.map((b) => b.map((i) => i.key));

function assertUniqueOutputs(f) {
  const outputs = f.items().map((i) => i.output).filter(Boolean);
  assert.equal(new Set(outputs).size, outputs.length, "two children share an output path");
}

// The whole graph: angles, search, extract with one retry, one split and one
// rejection, a size split into two synthesizers and a combiner, a review that
// lists gaps, a gap round, the final update, the receipt.
{
  const search = {
    "search-a": urlList([src("a", 1, "primary"), src("a", 2, "secondary"), src("a", 3, "secondary"), src("a", 4, "secondary")]),
    "search-b": urlList([src("b", 1, "primary"), src("b", 2, "secondary"), src("b", 3, "secondary")]),
    "search-c": urlList([src("c", 1, "primary"), src("c", 2, "secondary")]),
    "search-gap-pricing": urlList([src("gap-pricing", 1, "primary"), src("gap-pricing", 2, "secondary"), src("a", 1, "primary")]),
    "search-gap-sla": urlList([]),
  };
  const extract = {
    "extract-1": failed("extract-1", "503"),
    "extract-2": extractOver("extract-2"),
    "extract-2b": extractOver("extract-2b"),
    "extract-3": extractRejected("extract-3"),
    "extract-4": failed("extract-4", "boom"),
    "extract-4-retry": failed("extract-4-retry", "boom"),
    "extract-9": extractOk("extract-9", 20000),
    "extract-10": extractRejected("extract-10"),
  };
  const f = fake((item) => {
    switch (item.agent) {
      case "planner":
        return ok(item.key, {
          ok: true,
          angles: [
            { id: "a", question: "Question a?" },
            { id: "b", question: "Question b?" },
            { id: "c", question: "Question c?" },
          ],
        });
      case "searcher":
        return ok(item.key, search[item.key]);
      case "extractor":
        return extract[item.key] ?? extractOk(item.key);
      case "synthesizer":
        return ok(item.key, undefined);
      case "reviewer":
        return ok(item.key, {
          ok: true,
          verdict: "needs-work",
          clean: false,
          angles: [
            { id: "pricing", question: "Price?" },
            { id: "sla", question: "Uptime?" },
          ],
        });
    }
    throw new Error(`unexpected agent ${item.agent}`);
  });

  const receipt = await run(f.runs, { dir: "/t/d", goal: "The goal.", output: "/t/d/out.md", window: 150000 });

  assert.deepEqual(keys(f.batches), [
    ["angles"],
    ["search-a", "search-b", "search-c"],
    ["extract-0", "extract-1", "extract-2", "extract-3", "extract-4", "extract-5", "extract-6", "extract-7", "extract-8"],
    ["extract-1-retry", "extract-4-retry"],
    ["extract-2a", "extract-2b"],
    ["synthesis-0"],
    ["synthesis-1"],
    ["synthesis-combine"],
    ["review"],
    ["search-gap-pricing", "search-gap-sla"],
    ["extract-9", "extract-10"],
    ["synthesis-update"],
  ]);
  const byKey = Object.fromEntries(f.items().map((i) => [i.key, i]));

  assert.equal(byKey.angles.agent, "planner");
  assert.equal(byKey.angles.output, "/t/d/angles.md");
  assert.equal(byKey.angles.gate.command, "recipe-gate angles '/t/d/angles.md'");
  assert.match(byKey.angles.task, /Goal: The goal\./);

  assert.equal(byKey["search-a"].output, "/t/d/raw/search/search-a.md");
  assert.equal(byKey["search-a"].outputMode, "file-only");
  assert.equal(byKey["search-a"].gate.command, "recipe-gate urls '/t/d/raw/search/search-a.md'");
  assert.equal(byKey["search-a"].maxRuntimeMs, 1200000);
  assert.match(byKey["search-b"].task, /Angle: b\nQuestion: Question b\?/);

  assert.match(byKey["extract-0"].task, /URL: https:\/\/example\.com\/a\/1\nAngle: a\nPage: \/t\/d\/pages\/page-0\.md\nOutput: \/t\/d\/raw\/extract\/extract-0\.md/);
  assert.equal(byKey["extract-0"].gate.command, "recipe-gate extract '/t/d/raw/extract/extract-0.md'");
  assert.deepEqual(
    ["extract-0", "extract-1", "extract-2", "extract-3", "extract-4", "extract-5"].map((k) => /URL: (\S+)/.exec(byKey[k].task)[1]),
    ["a/1", "b/1", "c/1", "a/2", "b/2", "c/2"].map((p) => `https://example.com/${p}`),
  );

  assert.equal(byKey["extract-1-retry"].output, "/t/d/raw/extract/extract-1.retry.md");
  assert.equal(byKey["extract-1-retry"].task, byKey["extract-1"].task.replace("extract-1.md", "extract-1.retry.md"));
  assert.equal(byKey["extract-1-retry"].gate.command, "recipe-gate extract '/t/d/raw/extract/extract-1.retry.md'");
  assert.ok(!("extract-3-retry" in byKey), "a gate rejection is not retried");
  assert.match(byKey["extract-2a"].task, /Page: \/t\/d\/pages\/page-2a\.md/);
  assert.match(byKey["extract-2a"].task, /cover only the first half of its sections, by its outline/);
  assert.match(byKey["extract-2b"].task, /cover only the second half of its sections, by its outline/);
  assert.equal(byKey["extract-2b"].output, "/t/d/raw/extract/extract-2b.md");

  const files = (key) => byKey[key].task.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
  const ex = (name) => `/t/d/raw/extract/extract-${name}.md`;
  assert.deepEqual(files("synthesis-0"), [ex(0), ex(6), ex(8)]);
  assert.deepEqual(files("synthesis-1"), [ex("1.retry"), ex(7), ex("2a"), ex(5)]);
  assert.equal(byKey["synthesis-0"].output, "/t/d/synthesis-0.md");
  assert.deepEqual(files("synthesis-combine"), ["/t/d/synthesis-0.md", "/t/d/synthesis-1.md"]);
  assert.equal(byKey["synthesis-combine"].output, "/t/d/out.md");
  assert.match(byKey["synthesis-combine"].task, /Merge them into the requested output/);

  assert.equal(byKey.review.agent, "reviewer");
  assert.equal(byKey.review.gate.command, "recipe-gate gaps '/t/d/review.md'");
  assert.deepEqual(files("review"), [ex(0), ex("1.retry"), ex("2a"), ex(5), ex(6), ex(7), ex(8)]);
  assert.match(byKey.review.task, /Deliverable: \/t\/d\/out\.md/);

  assert.match(byKey["search-gap-pricing"].task, /Question: Price\?/);
  assert.deepEqual(
    [byKey["extract-9"], byKey["extract-10"]].map((i) => /URL: (\S+)/.exec(i.task)[1]),
    ["https://example.com/gap-pricing/1", "https://example.com/gap-pricing/2"],
  );
  assert.match(byKey["extract-9"].task, /Angle: gap-pricing/);

  assert.deepEqual(files("synthesis-update"), [ex(9)]);
  assert.equal(byKey["synthesis-update"].output, "/t/d/out.updated.md");
  assert.match(byKey["synthesis-update"].task, /Update the existing output at \/t\/d\/out\.md .* write the full updated document to \/t\/d\/out\.updated\.md\./);
  assertUniqueOutputs(f);

  assert.deepEqual(receipt, {
    output: "/t/d/out.updated.md",
    sources: { ok: 8, failed: 3, over_cap: 0 },
    open: [
      "source https://example.com/c/1: one half of the split failed",
      "source https://example.com/a/2: rejected (no passages)",
      "source https://example.com/b/2: failed (boom)",
      "review verdict needs-work; see /t/d/review.md",
      "search gap-sla: no sources listed",
      "source https://example.com/gap-pricing/2: rejected (no passages)",
      "gap gap-sla (Uptime?): no usable source",
    ],
    gap_round: true,
    children: 26,
  });
}

// At most four angles are used; a clean review ends the run without a gap
// round; one synthesizer when the notes fit; a page over the cap on both
// halves is counted as over the cap.
{
  const f = fake((item) => {
    switch (item.agent) {
      case "planner":
        return ok(item.key, { ok: true, angles: "abcdef".split("").map((id) => ({ id, question: `Q${id}?` })) });
      case "searcher":
        return ok(item.key, urlList([src(item.key.slice(7), 0, "primary")]));
      case "extractor":
        return item.key.startsWith("extract-0") ? extractOver(item.key) : extractOk(item.key, 1000);
      case "synthesizer":
        return ok(item.key, undefined);
      case "reviewer":
        return ok(item.key, { ok: true, verdict: "clean", clean: true, angles: [] });
    }
    throw new Error(`unexpected agent ${item.agent}`);
  });
  const receipt = await run(f.runs, { dir: "/t/e", goal: "G", output: "/t/e/out.md", format: "a table", maxSources: 3 });

  assert.deepEqual(keys(f.batches), [
    ["angles"],
    ["search-a", "search-b", "search-c", "search-d"],
    ["extract-0", "extract-1", "extract-2"],
    ["extract-0a", "extract-0b"],
    ["synthesis"],
    ["review"],
  ]);
  const synth = f.items().find((i) => i.key === "synthesis");
  assert.match(synth.task, /Requested output: a table/);
  assert.equal(synth.output, "/t/e/out.md");
  assertUniqueOutputs(f);
  assert.deepEqual(receipt, {
    output: "/t/e/out.md",
    sources: { ok: 2, failed: 0, over_cap: 1 },
    open: ["source https://example.com/a/0: over_cap"],
    gap_round: false,
    children: 12,
  });
}

// A planner that fails twice leaves the goal as the one angle; no sources
// ends the run with no output; a retry writes beside the failed child's file.
{
  const f = fake((item) => {
    if (item.agent === "planner") return failed(item.key, "503");
    return ok(item.key, urlList([]));
  });
  const receipt = await run(f.runs, { dir: "/t/f", goal: "G", output: "/t/f/out.md" });
  assert.deepEqual(keys(f.batches), [["angles"], ["angles-retry"], ["search-main"]]);
  assert.match(f.batches[2][0].task, /Question: G$/m);
  assert.equal(f.batches[1][0].output, "/t/f/angles.retry.md");
  assert.equal(f.batches[1][0].gate.command, "recipe-gate angles '/t/f/angles.retry.md'");
  assertUniqueOutputs(f);
  assert.deepEqual(receipt, {
    output: null,
    sources: { ok: 0, failed: 0, over_cap: 0 },
    open: [
      "angles: the planner produced no usable list, so the goal was searched as one angle",
      "search main: no sources listed",
      "no sources were found",
    ],
    gap_round: false,
    children: 3,
  });
}

// A synthesizer that fails twice leaves no output and no review.
{
  const f = fake((item) => {
    switch (item.agent) {
      case "planner":
        return ok(item.key, { ok: true, angles: [{ id: "a", question: "Q?" }] });
      case "searcher":
        return ok(item.key, urlList([src("a", 0, "primary")]));
      case "extractor":
        return extractOk(item.key, 1000);
      case "synthesizer":
        return failed(item.key, "engine");
    }
    throw new Error(`unexpected agent ${item.agent}`);
  });
  const receipt = await run(f.runs, { dir: "/t/g", goal: "G", output: "/t/g/out.md" });
  assert.deepEqual(keys(f.batches).slice(-2), [["synthesis"], ["synthesis-retry"]]);
  assert.equal(receipt.output, null);
  assert.deepEqual(receipt.open, ["the synthesizer failed, so there is no output"]);
  assert.equal(receipt.children, 5);
  assert.equal(f.batches.at(-1)[0].output, "/t/g/out.retry.md");
  assertUniqueOutputs(f);
}

// A path with a quote is shell-escaped in the gate commands.
{
  const f = fake((item) => ok(item.key, item.agent === "planner" ? { ok: true, angles: [{ id: "a b", question: "Q?" }] } : urlList([])));
  await run(f.runs, { dir: "/tmp/it's", goal: "G", output: "/x" });
  assert.equal(f.batches[0][0].gate.command, "recipe-gate angles '/tmp/it'\\''s/angles.md'");
  assert.equal(f.batches[1][0].key, "search-a-b");
  assert.equal(f.batches[1][0].gate.command, "recipe-gate urls '/tmp/it'\\''s/raw/search/search-a-b.md'");
}

console.log("research workflow: ok");
