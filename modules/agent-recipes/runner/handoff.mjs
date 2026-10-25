export const HANDOFF_ACTIONS = ["commit", "unread", "stop"];

function firstLine(text) {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.replace(/^[\s>*`_-]+/, "").replace(/[*`_]+/g, "").trim();
}

export function parseHandoff(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const line = firstLine(text);
  if (!/^handoff\s*:\s*(.*)$/i.test(line)) return null;
  const unread = [];
  for (const l of text.split("\n")) {
    const m = /^\s*[-*]?\s*unread\s*:\s*(.+)$/i.exec(l);
    if (!m) continue;
    for (const part of m[1].split(",")) {
      const item = part.replace(/`/g, "").trim();
      if (item && !unread.includes(item)) unread.push(item);
    }
  }
  return { line, unread };
}

const ACTION_STEPS = {
  commit:
    "Commit everything you have done with git first, then write the note with the sections `Done`, `Left` and `Watch for`.",
  unread:
    "Write the partial result in the requested format, in one write. Directly under the first line, before the partial result, put one line `unread: <path>` for each input you have not read in full.",
  stop: "Write what you found so far in the requested format.",
};

export function handoffPrompt(action, { output, tokens } = {}) {
  const steps = ACTION_STEPS[action];
  if (!steps) throw new Error(`unknown handoff action: ${action}`);
  const where = output ? `to ${output}` : "in your reply as text";
  const used = tokens ? ` (about ${tokens} tokens used)` : "";
  const reply = action === "unread" ? " Repeat the `unread:` lines in your reply." : "";
  const target = output ?? "your reply";
  const allowed =
    action === "commit"
      ? `Only git and writing ${target} are allowed from now on.`
      : `Only writing ${target} is allowed from now on.`;
  return [
    `You have reached your token budget${used}. Stop all new work now.`,
    steps,
    `Write ${where}. The first line of the note and of your reply must be \`handoff: <what is done; what is left>\`.${reply}`,
    allowed,
  ].join("\n");
}
