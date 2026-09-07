# Working in this repository

## Read in ranges

**Never whole-read a file over ~10 KB.** Use `read` with `offset` and `limit`,
or `grep` for the matches and read around them. The cap on `read` is 2000 lines
and 50 KB, which is not a guard: a 49 KB file lands in one tool result that
compaction cannot shrink once it is in the retained tail, and the session
enters a loop where every compaction still overflows. Whole-file reads — and
re-reads of the same file — are what has burned entire context windows here.
Index first (grep the section headers), then read ≤200-line ranges.

## Never truncate a search you are drawing a conclusion from

A truncated match list reads exactly like an absent one. `grep … | head` has
produced confidently wrong root-cause calls here — code reported missing that
was present three matches down. Before concluding something does not exist,
count the matches (`grep -c`, or the `grep` tool with no `limit`), and only
then narrow. Truncate to read; never truncate to decide.

Not every child has a shell — `reviewer` has no `bash`, and `researcher` has
only `read` plus the web tools — so use whichever of the `grep` tool or the
shell you were actually given, and treat this as a rule about evidence rather
than about a command.

## Return a pointer, not a report — unless you cannot write

If you have a write tool: write findings to the output path you were given, and
keep the final response to the verdict and the file paths that support it. The
parent may be holding a context window you are about to spend; the file is
where the detail belongs.

**If you have no write tool, do the opposite: return the complete artifact in
your final response.** The runtime persists that message to the output path for
you, so a short answer is not a lean answer — it is the whole deliverable,
lost. Your run-time instructions say which case you are in; they are
authoritative and they override this file. `reviewer` is the read-only case
here.
