# Working in this repository

## Read in ranges

**Never whole-read a file over ~10 KB.** Use `read` with `offset` and `limit`,
or `grep` and read around the matches. `read`'s 2000-line / 50 KB cap is not a
guard: one large tool result cannot be compacted away once it is in the
retained tail, and every later compaction still overflows. Index first (grep
the headers), then read ranges of ≤200 lines. Do not re-read the same file.

## Never truncate a search you are drawing a conclusion from

A truncated match list looks exactly like an absent one; `grep … | head` has
produced confidently wrong "this code does not exist" calls here. Before
concluding something is absent, count the matches (`grep -c`, or the `grep`
tool with no `limit`), then narrow. Truncate to read; never truncate to decide.
This is a rule about evidence, not a command: `reviewer` has no `bash` and
`researcher` has only `read` plus web tools, so use whichever search you have.

## Return a pointer, not a report — unless you cannot write

If you have a write tool: write findings to the output path you were given and
keep the final response to the verdict plus the supporting file paths. The
detail belongs in the file, not in the parent's context.

**If you have no write tool (`reviewer`), return the complete artifact in your
final response.** The runtime persists that message to the output path; a short
answer is the whole deliverable, lost. Your run-time instructions say which
case you are in and override this file.
