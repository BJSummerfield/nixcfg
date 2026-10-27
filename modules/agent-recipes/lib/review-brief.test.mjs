import assert from "node:assert/strict";
import { reviewBriefLines } from "./review-brief.mjs";

const base = {
  taskFile: "/t/task.md",
  repo: "/r",
  branch: "pi/b",
  diffRange: "base0..pi/b",
  owns: ["a.mjs", "b.mjs"],
  check: "npm test",
  output: "/o/review.md",
};

function testFullBrief() {
  assert.deepEqual(
    reviewBriefLines({ ...base, implementerWorktree: "/wt/b", revisedTask: "/t/revised.md" }),
    [
      "Review a diff on a branch (the diff variant).",
      "Task file: /t/task.md",
      "Repository: /r",
      "Branch: pi/b",
      "Worktree: your working directory is your own worktree of the branch; read and run the check there and make no other worktree. The implementer's worktree /wt/b is not yours: never read or run anything in it.",
      "Diff to review: git diff base0..pi/b",
      "Owned files: a.mjs, b.mjs",
      "Check to run: npm test",
      "Revised task (wins over the task file): the ## Brief section of /t/revised.md",
      "Write the report to /o/review.md",
    ],
  );
}

function testMinimalBrief() {
  const lines = reviewBriefLines(base);
  assert.equal(lines.length, 9);
  assert.ok(!lines.some((l) => l.startsWith("Revised task")));
  assert.ok(lines[4].endsWith("make no other worktree."));
  assert.equal(lines[8], "Write the report to /o/review.md");
}

testFullBrief();
testMinimalBrief();
