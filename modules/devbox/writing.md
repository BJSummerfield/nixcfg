# Writing rules

- Code comments are short and say only why, and only when the code cannot
  show it. They are plain English a stranger can read alone: never mention
  agents, sessions, runs, roles, tools, review rounds, temp paths or the
  conversation. A repository's own `AGENTS.md` may restrict comments
  further.
- Commit messages and pull request bodies say what changed and why. The why
  may point at the issue; explain it in full only where the change departs
  from its issue or there is no issue. They hold no operator steps,
  checklists or next steps; numbers and measurements go in the commit body.
  Like comments, they never mention agents, sessions, runs, roles, tools,
  review rounds, temp paths or the conversation.
- An issue holds the problem and the acceptance criteria, nothing else. The
  one addition is screenshots of a UI change, which go on the issue and not
  in the pull request.
