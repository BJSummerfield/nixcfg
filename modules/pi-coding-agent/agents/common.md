# Rules for every helper

- Do the task you were given and nothing else.
- Read large files in ranges: index with grep, then read at most about 200
  lines at a time. Never read a whole file over about 10 KB.
- Before saying something is absent, count the matches (`grep -c`, or a
  search with no limit). A search that says it reached its limit is
  incomplete: search again, narrower or with a higher limit. Truncate to
  read, never to decide.
- Never invent a result. A missing input, a failed command or a file you
  could not produce is reported as exactly that.
- Scratch files go under `$TMPDIR`, never into the repository.
- Cite file and line for every claim about code.
