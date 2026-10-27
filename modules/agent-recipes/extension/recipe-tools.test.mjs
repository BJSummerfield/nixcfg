/**
 * Behaviour tests for the recipe tools. Run by `nix flake check`.
 *
 * The runner binary is a fake node script that writes the files it is asked
 * for and exits after 200 ms; pi is a stub that records registrations.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import recipeTools from "./recipe-tools.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-tools-"));
const fake = path.join(tmp, "fake-run.mjs");
fs.writeFileSync(
  fake,
  `import fs from "node:fs";
import path from "node:path";
const a = process.argv.slice(2);
const flag = (n) => a[a.indexOf(n) + 1];
setTimeout(() => {
  if (a[0] === "run" || a[0] === "resume") {
    const dir = a[0] === "resume" ? a[1] : JSON.parse(flag("--args")).dir;
    fs.mkdirSync(path.join(dir, "runner"), { recursive: true });
    if (a[0] === "run" && JSON.parse(flag("--args")).die) {
      console.error("a run is already going in " + dir);
      process.exit(1);
    }
    fs.writeFileSync(path.join(dir, "runner", "status.json"), JSON.stringify({ state: "complete", pid: process.pid }));
    fs.writeFileSync(path.join(dir, "receipt.json"), JSON.stringify({ answer: "x".repeat(3000) }));
  } else if (a[0] === "dispatch") {
    fs.writeFileSync(flag("--result-file"), JSON.stringify({ ok: true, status: "done", output: "o.md", outputExists: true, gate: null, usage: { prompt: 5, cached: 1, output: 2 } }));
  }
}, 200);
`,
);
const env = { ...process.env, TMPDIR: tmp, RECIPE_RUN_BIN: JSON.stringify([process.execPath, fake]) };

function fakePi() {
  const pi = { tools: {}, handlers: {}, sent: [] };
  pi.registerTool = (t) => {
    pi.tools[t.name] = t;
  };
  pi.on = (name, fn) => {
    pi.handlers[name] = fn;
  };
  pi.sendMessage = (message, options) => pi.sent.push({ message, options });
  return pi;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctx = { cwd: tmp };

{
  const pi = fakePi();
  recipeTools(pi, { env: { ...env, RECIPE_CHILD: "1" } });
  assert.deepEqual(Object.keys(pi.tools), []);
  assert.deepEqual(Object.keys(pi.handlers), []);
}

{
  const pi = fakePi();
  recipeTools(pi, { env });
  assert.deepEqual(Object.keys(pi.tools).sort(), ["recipe_dispatch", "recipe_run"]);
  assert.equal(pi.sent.length, 0);

  await assert.rejects(() => pi.tools.recipe_run.execute("1", { recipe: "plan", args: { dir: "rel" } }, null, null, ctx));

  const dir = path.join(tmp, "task");
  const t0 = Date.now();
  const started = await pi.tools.recipe_run.execute("1", { recipe: "plan", args: { dir } }, null, null, ctx);
  assert.ok(Date.now() - t0 < 150, "start returns before the runner exits");
  assert.equal(started.details.taskDir, dir);
  assert.ok(started.details.pid > 0);
  assert.match(started.content[0].text, /woken once/);
  assert.equal(pi.sent.length, 0);
  await sleep(700);
  assert.equal(pi.sent.length, 1);
  const { message, options } = pi.sent[0];
  assert.equal(message.customType, "recipe-run");
  assert.equal(options.triggerTurn, true);
  assert.equal(options.deliverAs, "followUp");
  const text = message.content[0].text;
  assert.ok(text.startsWith(`Recipe plan complete. Receipt: ${dir}/receipt.json`));
  assert.ok(text.length < 1200);

  const fg = await pi.tools.recipe_dispatch.execute("2", { role: "scout", brief: "look" }, null, null, ctx);
  assert.equal(fg.details.status, "done");
  assert.match(fg.content[0].text, /Dispatch done/);
  assert.equal(pi.sent.length, 1);

  const bg = await pi.tools.recipe_dispatch.execute("3", { role: "scout", brief: "look", background: true }, null, null, ctx);
  assert.ok(bg.details.id && bg.details.resultFile);
  assert.equal(pi.sent.length, 1);
  await sleep(700);
  assert.equal(pi.sent.length, 2);
  assert.equal(pi.sent[1].message.customType, "recipe-dispatch");
  assert.equal(pi.sent[1].message.details.result.status, "done");
  assert.equal(pi.sent[1].options.triggerTurn, true);
}

// a run that exits without writing its own status is not reported with an older run's status
{
  const pi = fakePi();
  recipeTools(pi, { env });
  const dir = path.join(tmp, "task3");
  fs.mkdirSync(path.join(dir, "runner"), { recursive: true });
  fs.writeFileSync(path.join(dir, "runner", "status.json"), JSON.stringify({ state: "running", pid: 1 }));
  await pi.tools.recipe_run.execute("1", { recipe: "plan", args: { dir, die: true } }, null, null, ctx);
  await sleep(700);
  assert.equal(pi.sent.length, 1);
  const text = pi.sent[0].message.content[0].text;
  assert.match(text, /the run exited before starting: exit 1/);
  assert.match(text, /a run is already going/);
  assert.doesNotMatch(text, /running\./);
}

// a run that cannot be spawned is an error, not a silent start
{
  const pi = fakePi();
  recipeTools(pi, { env });
  const dir = path.join(tmp, "task4");
  await assert.rejects(
    () => pi.tools.recipe_run.execute("1", { recipe: "plan", args: { dir }, cwd: path.join(tmp, "no-such-dir") }, null, null, ctx),
    /could not start the run: .*ENOENT/,
  );
  await sleep(300);
  assert.equal(pi.sent.length, 0);
}

{
  const pi = fakePi();
  recipeTools(pi, { env });
  const dir = path.join(tmp, "task2");
  await pi.tools.recipe_run.execute("1", { recipe: "plan", args: { dir } }, null, null, ctx);
  await pi.tools.recipe_dispatch.execute("3", { role: "scout", brief: "look", background: true }, null, null, ctx);
  pi.handlers.session_shutdown();
  await sleep(700);
  assert.equal(pi.sent.length, 0);
}

{
  const pi = fakePi();
  recipeTools(pi, { env });
  assert.equal("maxChildren" in pi.tools.recipe_run.parameters.properties, false);
  assert.equal("gateJson" in pi.tools.recipe_dispatch.parameters.properties, false);
  assert.equal("keepWorktree" in pi.tools.recipe_dispatch.parameters.properties, false);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("recipe-tools tests passed");
