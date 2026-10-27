export function reviewBriefLines({
  taskFile,
  repo,
  branch,
  implementerWorktree,
  diffRange,
  owns,
  check,
  output,
  revisedTask,
}) {
  const own = "Worktree: your working directory is your own worktree of the branch; read and run the check there and make no other worktree.";
  const worktree =
    typeof implementerWorktree === "string" && implementerWorktree !== ""
      ? `${own} The implementer's worktree ${implementerWorktree} is not yours: never read or run anything in it.`
      : own;
  return [
    "Review a diff on a branch (the diff variant).",
    `Task file: ${taskFile}`,
    `Repository: ${repo}`,
    `Branch: ${branch}`,
    worktree,
    `Diff to review: git diff ${diffRange}`,
    `Owned files: ${owns.join(", ")}`,
    `Check to run: ${check}`,
    ...(typeof revisedTask === "string" && revisedTask !== ""
      ? [`Revised task (wins over the task file): the ## Brief section of ${revisedTask}`]
      : []),
    `Write the report to ${output}`,
  ];
}
