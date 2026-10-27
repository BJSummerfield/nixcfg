export function finalItems(lib, dir, commands) {
  return commands.map(function (c, i) {
    const n = i + 1;
    return lib.gateOnly(
      "final-" + n,
      "recipe-gate repro " + lib.quote(dir) + " --command " + lib.quote(c) + " --expect pass --id final-" + n + " --in " + lib.quote(dir + "/integration") + " --timeout-ms 3600000",
      { big: true, gateTimeoutMs: 3660000 },
    );
  });
}

export function finalResult(commands, results) {
  if (!commands.length) return "none";
  const failed = [];
  commands.forEach(function (c, i) {
    const r = results[i];
    if (r && r.structuredOutput && r.structuredOutput.ok) return;
    const reason = (r && r.structuredOutput && r.structuredOutput.reason) || (r && r.error) || "did not run";
    failed.push(c + ": " + reason);
  });
  return failed.length ? "fail: " + failed.join("; ") : "pass";
}
