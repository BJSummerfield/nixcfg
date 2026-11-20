# Delegating work to Paseo agents

- Delegate bulk reading, searching, mechanical edits, test runs and first
  drafts. Do a lookup of a few commands yourself. Do judgement-heavy work
  (plans, design choices, final review) yourself, or, if you are a Claude
  agent, give it to another Claude agent.
- An agent started with a brief follows it, and starts agents of its own only
  if the brief says so.
- Local model: `--provider @localModel@`. Claude:
  `--provider claude/<model>`, for review and anything a decision rests on;
  only a Claude agent starts Claude agents.
- At most @localLanes@ local-model agents at once, fewer if you also run on
  the local model. Extra requests wait for a free lane; one that waits more
  than @localQueueMinutes@ minutes fails with HTTP 503 (`request_queue_timeout`),
  which pi retries before the turn fails. Claude agents use no local
  capacity. One agent per independent slice of work: one per question for
  research, one per file group for edits. Never two writers on the same
  files.
- A read-only worker shares your workspace:
  `paseo run --no-wait --title <t> --provider <p> "<brief>"`.
- A worker that edits files gets its own worktree and branch, in a hidden
  workspace: `paseo workspace create --isolation worktree --mode branch-off
  --new-branch <name> --base <ref> --worktree-slug <slug> --background`, then
  `paseo run --no-wait --workspace <workspace-id> --title <t> --provider <p>
  "<brief>"`. Bring its commits back with `git merge` or `git cherry-pick`.
- Keep every workspace and agent id from the launch output; hidden workspaces
  and the agents in them show only with `paseo workspace ls --background` and
  `paseo ls --background`.
- The worker sees none of your conversation. The brief states the goal,
  absolute input paths, one absolute output path, a budget in tool calls or
  minutes, and that the output's first line is `DONE:`, `FAILED: <why>` or
  `BLOCKED: <decision needed>`, and that its last step is the ping below. It
  forbids starting agents, detaching processes (`setsid`, `nohup`, `&`), edits outside named files, `git stash`,
  `git push` and switching branches. For a structured answer from a
  local-model agent, add `--output-schema <json-schema>` to a run without
  `--no-wait`.
- Do not poll. The brief gives the worker your agent id (`$PASEO_AGENT_ID`)
  and ends with its last step: `paseo send <your-id> --no-wait "DONE <task>:
  <first line of output> <output path>"`. The output file is the truth; the
  message only wakes you. A plain send reaches you after your current turn
  ends; `--behavior interrupt` reaches you at once. A send also wakes an
  archived agent, so never address an archived or replaced one. Never end a
  turn waiting on workers unless a running one will ping you.
- Never run `paseo wait`: it blocks your session until its timeout even when
  the worker has already pinged, and pings that arrive meanwhile are held
  until it returns. If a ping may have been missed, check
  `paseo inspect <id> --json` for status and the output file, and
  `paseo logs <id>` for what the worker did.
- Start a long-lived coordinator from the main session with no `--workspace`,
  so it stays visible; workers it launches stay hidden. A coordinator never
  starts its own successor: it writes its state to a file, pings the main
  session `HANDOFF:` and ends.
- A launch with a bad model name also exits 0; the failure shows only in
  `paseo inspect` and `paseo logs`. Judge every agent by its status and its
  output file, never by an exit code.
- Local-model reports can be confidently wrong. Check the facts a decision
  rests on before acting; a Claude agent hands review to a Claude agent, a
  local-model agent names in its report what still needs review.
- A stuck agent: `paseo stop <id>`. It does not kill processes the agent
  started with `setsid`.
- When done: `paseo workspace archive <workspace-id>` for a worker's
  worktree, after its commits are merged; it deletes the directory and every
  file in it, committed or not; the branch survives. `paseo archive <id>`
  for a worker in your own workspace; it deletes no files. Never
  `paseo delete --all` or `paseo delete --cwd`.
