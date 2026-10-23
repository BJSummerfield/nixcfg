{
  nixpkgs,
  inputs,
  pkgs,
}:
let
  evalOnly = name: drvPath: builtins.seq drvPath (pkgs.runCommand "eval-${name}" { } "touch $out");
  evalAll =
    prefix:
    nixpkgs.lib.mapAttrs' (
      name: cfg:
      let
        checkName = "${prefix}-${name}";
      in
      nixpkgs.lib.nameValuePair checkName (evalOnly checkName cfg.config.system.build.toplevel.drvPath)
    );
  lintSrc = pkgs.lib.cleanSource ../.;
  hwConfigGlob = "hosts/*/hardware-configuration.nix";

  valheimNotify = pkgs.callPackage ../modules/valheim-server/notify-package.nix { };
  piSubagents = pkgs.callPackage ../modules/pi-coding-agent/pi-subagents-patched.nix { };
  piSubagentsGroupKillCheck = pkgs.writeText "pi-subagents-group-kill-check.mjs" ''
    import { spawn, execFileSync } from "node:child_process";
    import { createOwnedProcessTreeController } from "./owned-process-tree.js";
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const alive = (pid) => {
      try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
    };
    // Topology of a timed-out background run: the runner is a detached process-
    // group leader; its bash tool is a detached child in its own group, with the
    // probe as a grandchild in that group. terminate(runner) must kill all of it.
    // The whole tree is pure node (no system shell): runner.mjs spawns the
    // detached "bash" (bash.mjs), which spawns the "probe" in its own group.
    const runner = spawn(process.execPath, [ "runner.mjs", "bash.mjs" ], { detached: true, stdio: "ignore" });
    await sleep(800);
    const rows = execFileSync("ps", [ "-axo", "pid=,ppid=,pgid=,comm=" ], { encoding: "utf8" })
      .trim().split("\n").map((l) => l.trim().split(/\s+/));
    const bashRow = rows.find((r) => r[1] === String(runner.pid) && r[0] !== String(runner.pid));
    if (!bashRow) { console.error("no detached bash child of the runner"); process.exit(1); }
    const bashPid = Number(bashRow[0]);
    const probeRows = rows.filter((r) => r[2] === String(bashRow[2]) && r[0] !== String(bashPid));
    const outcome = await createOwnedProcessTreeController(runner.pid, { termGraceMs: 300, killVerifyMs: 500 })
      .terminate();
    await sleep(300);
    const survivors = [ runner.pid, bashPid, ...probeRows.map((r) => Number(r[0])) ].filter(alive);
    if (survivors.length > 0) { console.error("survivors:", survivors, outcome); process.exit(1); }
    if (outcome.state !== "observed") { console.error("unverified outcome:", outcome); process.exit(1); }
  '';

  # Runs the runner's OWN group-ownership code (the gate of the group-backstop
  # and SIGTERM hooks) as extracted from the built patched runner, inside a
  # real detached child (a process-group leader -> expects true) and a plain
  # child (not a leader -> expects false). A module-load check would be green
  # over the pre-fix runner: the crash only happens when the function is
  # called, and it threw `TypeError: process.getpgrp is not a function` there.
  piSubagentsGroupKillOwnershipCheck = pkgs.writeText "pi-subagents-group-kill-ownership-check.mjs" ''
    import { spawn } from "node:child_process";
    const runChild = (opts) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [ "ownership-child.mjs" ], {
          stdio: [ "ignore", "pipe", "inherit" ],
          ...opts,
        });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.on("close", (code) => resolve({ code, out: out.trim() }));
      });
    const detached = await runChild({ detached: true });
    if (detached.code !== 0 || detached.out !== "true") {
      console.error("detached child expected ownership true, got:", detached);
      process.exit(1);
    }
    const plain = await runChild({});
    if (plain.code !== 0 || plain.out !== "false") {
      console.error("plain child expected ownership false, got:", plain);
      process.exit(1);
    }
    console.log("ownership check: detached child owns its process group (true), plain child does not (false); no TypeError");
  '';
  # Runs in a child of the ownership check: extracts the ownsOwnProcessGroup
  # arrow function from the built patched runner source (brace-balanced; the
  # body contains no braces in strings or comments) and executes it in this
  # process. Prints "true"/"false" or fails with the thrown error.
  piSubagentsGroupKillOwnershipChild = pkgs.writeText "pi-subagents-group-kill-ownership-child.mjs" ''
    import * as fs from "node:fs";
    import { fileURLToPath } from "node:url";
    const src = fs.readFileSync(fileURLToPath(new URL("./subagent-runner.js", import.meta.url)), "utf8");
    const anchor = "const ownsOwnProcessGroup = ";
    const start = src.indexOf(anchor);
    if (start === -1) {
      console.error("ownsOwnProcessGroup not found in the built runner");
      process.exit(1);
    }
    const body = src.slice(start + anchor.length);
    let depth = 0;
    let end = -1;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === -1) {
      console.error("unbalanced braces in ownsOwnProcessGroup");
      process.exit(1);
    }
    const own = new Function("fs", "process", "return " + body.slice(0, end) + ";");
    try {
      const owns = own(fs, process)();
      console.log(owns === true ? "true" : "false");
    } catch (error) {
      console.error(String(error));
      process.exit(2);
    }
  '';

  piSubagentsGroupKillRunner = pkgs.writeText "pi-subagents-group-kill-runner.mjs" ''
    import { spawn } from "node:child_process";
    // The detached "bash tool": a child in its own process group, exactly like
    // the pi bash tool. Its path is passed as argv[2] so no system shell or
    // absolute path is needed in the build sandbox.
    spawn(process.execPath, [ process.argv[2] ], { detached: true, stdio: "ignore" });
    setInterval(() => {}, 1000);
  '';
  piSubagentsGroupKillBash = pkgs.writeText "pi-subagents-group-kill-bash.mjs" ''
    import { spawn } from "node:child_process";
    // The probe: a grandchild in this process group (not detached), mirroring
    // the probe/node the bash tool would leave running.
    spawn(process.execPath, [ "-e", "setInterval(() => {}, 1000)" ], { stdio: "ignore" });
    setInterval(() => {}, 1000);
  '';

  # No annotations in the lines themselves (systemd journal lines never have
  # any): the sample covers a join, a death, a respawn, a version-mismatch
  # failed join and a leave, plus a second player who actually joins after the
  # first player's respawn, to prove the "a respawn of an already-joined name
  # is ignored" rule doesn't also swallow a genuine later join.
  valheimNotifySample = pkgs.writeText "valheim-notify-sample.txt" ''
    09/10/2026 21:14:02: Player history entry with index 0:  infestedmrt (Steam_76561198044411510, 4C8BF26B49A14417)
    09/10/2026 21:14:03: Player history entry with index 1:  Bjorn Ironside (Steam_76561198044411999, 5D9CF37C5AB25528)
    09/10/2026 21:14:05: Valheim version: l-1.0.12 (network version 40)
    09/10/2026 21:14:30: Game server connected
    09/10/2026 21:20:00: Got connection SteamID 76561198044411510
    09/10/2026 21:20:01: Network version check, their:40, mine:40
    09/10/2026 21:20:25: Got character ZDOID from TeChNo ViKiNg : 1930526702:19
    09/10/2026 21:24:00: Connections 1 ZDOS:170402  sent:0 recv:0
    09/10/2026 21:30:00: Got character ZDOID from TeChNo ViKiNg : 0:0
    09/10/2026 21:30:10: Got character ZDOID from TeChNo ViKiNg : 1930526702:44
    09/10/2026 21:31:00: Got connection SteamID 76561198044411999
    09/10/2026 21:31:05: Network version check, their:40, mine:40
    09/10/2026 21:31:20: Got character ZDOID from Bjorn Ironside : 2200000000:5
    09/10/2026 21:35:00: Got connection SteamID 76561190000000001
    09/10/2026 21:35:05: Network version check, their:39, mine:40
    09/10/2026 21:35:06: Closing socket 76561190000000001
    09/10/2026 21:36:00: Closing socket 76561198044411999
    09/10/2026 21:40:00: Closing socket 76561198044411510
  '';

  valheimNotifyExpected = pkgs.writeText "valheim-notify-expected.txt" ''
    up l-1.0.12
    join 76561198044411510 TeChNo ViKiNg (1 online)
    join 76561198044411999 Bjorn Ironside (2 online)
    mismatch 39 40
    leave 76561198044411999 Bjorn Ironside (1 online)
    leave 76561198044411510 TeChNo ViKiNg (0 online)
  '';
in
evalAll "nixos" inputs.self.nixosConfigurations
// evalAll "darwin" inputs.self.darwinConfigurations
// {
  fmt-check =
    pkgs.runCommand "fmt-check"
      {
        nativeBuildInputs = [
          inputs.self.formatter.x86_64-linux
          pkgs.git
        ];
      }
      ''
        cp -r --no-preserve=mode ${lintSrc} src
        cd src
        git init -q
        git add -Af
        treefmt --fail-on-change --no-cache
        touch $out
      '';
  statix-check =
    pkgs.runCommand "statix-check"
      {
        nativeBuildInputs = [ pkgs.statix ];
      }
      ''
        cd ${lintSrc}
        statix check .
        touch $out
      '';
  deadnix-check =
    pkgs.runCommand "deadnix-check"
      {
        nativeBuildInputs = [ pkgs.deadnix ];
      }
      ''
        cd ${lintSrc}
        deadnix --fail . --exclude ${hwConfigGlob}
        touch $out
      '';
  # The valve gives a subagent one more turn when its reply is cut off. Its input
  # (stopReason) is pi's, not ours, so the branches are worth pinning even though
  # the harness semantics around them can only be verified by reading pi's source.
  pi-budget-valve =
    pkgs.runCommand "pi-budget-valve"
      {
        nativeBuildInputs = [ pkgs.nodejs ];
      }
      ''
        cp ${../modules/pi-coding-agent/extensions/budget-valve.js} budget-valve.js
        cp ${../modules/pi-coding-agent/extensions/budget-valve.test.mjs} budget-valve.test.mjs
        node budget-valve.test.mjs
        touch $out
      '';
  pi-save-page =
    pkgs.runCommand "pi-save-page"
      {
        nativeBuildInputs = [ pkgs.nodejs ];
      }
      ''
        cp ${../modules/pi-coding-agent/extensions/save-page.js} save-page.js
        cp ${../modules/pi-coding-agent/extensions/save-page.test.mjs} save-page.test.mjs
        node save-page.test.mjs
        touch $out
      '';
  # The resume card replaces pi's default summariser with a fixed template on
  # every compaction. Its input (session_before_compact's payload shape) is
  # pi's, not ours, so pinning it here only proves the template, not pi's side.
  pi-resume-card =
    pkgs.runCommand "pi-resume-card"
      {
        nativeBuildInputs = [ pkgs.nodejs ];
      }
      ''
        cp ${../modules/pi-coding-agent/extensions/resume-card.js} resume-card.js
        cp ${../modules/pi-coding-agent/extensions/resume-card.test.mjs} resume-card.test.mjs
        node resume-card.test.mjs
        touch $out
      '';
  pi-recipe-gate =
    pkgs.runCommand "pi-recipe-gate"
      {
        nativeBuildInputs = [
          pkgs.nodejs
          pkgs.git
        ];
      }
      ''
        cp ${../modules/agent-recipes/gates/recipe-gate.mjs} recipe-gate.mjs
        cp ${../modules/agent-recipes/gates/recipe-git.mjs} recipe-git.mjs
        cp ${../modules/agent-recipes/gates/recipe-gate.test.mjs} recipe-gate.test.mjs
        node recipe-gate.test.mjs
        touch $out
      '';
  pi-recipe-git =
    pkgs.runCommand "pi-recipe-git"
      {
        nativeBuildInputs = [
          pkgs.nodejs
          pkgs.git
        ];
      }
      ''
        cp ${../modules/agent-recipes/gates/recipe-gate.mjs} recipe-gate.mjs
        cp ${../modules/agent-recipes/gates/recipe-git.mjs} recipe-git.mjs
        cp ${../modules/agent-recipes/gates/recipe-git.test.mjs} recipe-git.test.mjs
        node recipe-git.test.mjs
        status=0
        ${pkgs.callPackage ../modules/agent-recipes/package.nix { }}/bin/recipe-gate bogus x || status=$?
        test "$status" = 2
        touch $out
      '';
  pi-recipe-lib =
    pkgs.runCommand "pi-recipe-lib"
      {
        nativeBuildInputs = [ pkgs.nodejs ];
      }
      ''
        mkdir lib
        cp ${../modules/agent-recipes/lib/recipe-lib.js} lib/recipe-lib.js
        cp ${../modules/agent-recipes/lib/recipe-lib.test.mjs} lib/recipe-lib.test.mjs
        node lib/recipe-lib.test.mjs
        touch $out
      '';
  pi-recipe-implement =
    pkgs.runCommand "pi-recipe-implement"
      {
        nativeBuildInputs = [ pkgs.nodejs ];
      }
      ''
        mkdir lib implement
        cp ${../modules/agent-recipes/lib/recipe-lib.js} lib/recipe-lib.js
        cp ${../modules/agent-recipes/implement/graph.js} implement/graph.js
        cp ${../modules/agent-recipes/implement/graph.test.mjs} implement/graph.test.mjs
        node implement/graph.test.mjs
        touch $out
      '';
  pi-recipe-plan =
    pkgs.runCommand "pi-recipe-plan"
      {
        nativeBuildInputs = [ pkgs.nodejs ];
      }
      ''
        mkdir lib plan
        cp ${../modules/agent-recipes/lib/recipe-lib.js} lib/recipe-lib.js
        cp ${../modules/agent-recipes/plan/graph.js} plan/graph.js
        cp ${../modules/agent-recipes/plan/graph.test.mjs} plan/graph.test.mjs
        node plan/graph.test.mjs
        touch $out
      '';
  pi-recipe-research =
    pkgs.runCommand "pi-recipe-research"
      {
        nativeBuildInputs = [ pkgs.nodejs ];
      }
      ''
        mkdir lib research
        cp ${../modules/agent-recipes/lib/recipe-lib.js} lib/recipe-lib.js
        cp ${../modules/agent-recipes/research/graph.js} research/graph.js
        cp ${../modules/agent-recipes/research/graph.test.mjs} research/graph.test.mjs
        node research/graph.test.mjs
        touch $out
      '';
  pi-recipe-sizing =
    pkgs.runCommand "pi-recipe-sizing"
      {
        nativeBuildInputs = [ pkgs.nodejs ];
      }
      ''
        cp ${../modules/agent-recipes/sizing/recipe-sizing.mjs} recipe-sizing.mjs
        cp ${../modules/agent-recipes/sizing/recipe-sizing.test.mjs} recipe-sizing.test.mjs
        node recipe-sizing.test.mjs
        touch $out
      '';
  pi-recipe-status =
    pkgs.runCommand "pi-recipe-status"
      {
        nativeBuildInputs = [ pkgs.nodejs ];
      }
      ''
        cp ${../modules/agent-recipes/status/recipe-status.mjs} recipe-status.mjs
        cp ${../modules/agent-recipes/status/recipe-status.test.mjs} recipe-status.test.mjs
        node recipe-status.test.mjs
        touch $out
      '';
  # pi-subagents 0.78.0 leaves a run's detached bash tool tree orphaned when the
  # run ends on its deadline (scene_gen #153). The vendored package patches the
  # runner to terminate its whole process group. This check runs the patched
  # controller against that exact topology, and separately executes the
  # runner's ownsOwnProcessGroup gate (the group-backstop and SIGTERM hooks)
  # inside a real detached child and a plain child — a module-load check
  # would be green over the pre-fix runner, whose crash only happened when
  # that function was called. Baseline before the patch: the outcome was
  # unknown/verification-failed, the bash tree survived, and the ownership
  # function threw `TypeError: process.getpgrp is not a function`.
  pi-subagents-group-kill =
    pkgs.runCommand "pi-subagents-group-kill-check"
      {
        # procps provides the ps the check uses to read pid/ppid/pgid in the
        # build sandbox, where /bin and the host process tools are absent.
        nativeBuildInputs = [
          pkgs.nodejs
          pkgs.procps
        ];
      }
      ''
        cp ${piSubagents}/src/runs/background/owned-process-tree.js .
        cp ${piSubagents}/src/runs/background/subagent-runner.js .
        cp ${piSubagentsGroupKillCheck} group-kill-check.mjs
        cp ${piSubagentsGroupKillRunner} runner.mjs
        cp ${piSubagentsGroupKillBash} bash.mjs
        cp ${piSubagentsGroupKillOwnershipCheck} ownership-check.mjs
        cp ${piSubagentsGroupKillOwnershipChild} ownership-child.mjs
        node group-kill-check.mjs
        node ownership-check.mjs
        touch $out
      '';
  valheim-notify-parser =
    pkgs.runCommand "valheim-notify-parser"
      {
        nativeBuildInputs = [ valheimNotify ];
      }
      ''
        valheim-notify parse <${valheimNotifySample} >actual
        diff -u ${valheimNotifyExpected} actual
        touch $out
      '';
}
// nixpkgs.lib.mapAttrs' (
  name: drv: nixpkgs.lib.nameValuePair "pkg-${name}" drv
) inputs.self.packages.x86_64-linux
