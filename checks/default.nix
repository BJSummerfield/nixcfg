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
    import { createOwnedProcessTreeController } from "./pkg/src/runs/background/owned-process-tree.js";
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const alive = (pid) => {
      try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
    };
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
  piSubagentsGroupKillOwnershipChild = pkgs.writeText "pi-subagents-group-kill-ownership-child.mjs" ''
    import * as fs from "node:fs";
    import { fileURLToPath } from "node:url";
    const src = fs.readFileSync(fileURLToPath(new URL("./pkg/src/runs/background/subagent-runner.js", import.meta.url)), "utf8");
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
    spawn(process.execPath, [ process.argv[2] ], { detached: true, stdio: "ignore" });
    setInterval(() => {}, 1000);
  '';
  piSubagentsGroupKillBash = pkgs.writeText "pi-subagents-group-kill-bash.mjs" ''
    import { spawn } from "node:child_process";
    process.on("SIGTERM", () => {});
    spawn(process.execPath, [ "-e", "process.on('SIGTERM',()=>{});setInterval(() => {}, 1000)" ], { stdio: "ignore" });
    setInterval(() => {}, 1000);
  '';

  piSubagentsDepsCheck = pkgs.writeText "pi-subagents-deps-check.mjs" ''
    import * as fs from "node:fs";
    const pkg = JSON.parse(fs.readFileSync(new URL("./pkg/package.json", import.meta.url), "utf8"));
    const deps = pkg.dependencies ?? {};
    for (const name of Object.keys(deps)) {
        const manifest = new URL("./pkg/node_modules/" + name + "/package.json", import.meta.url);
        if (!fs.existsSync(manifest)) {
            console.error("missing runtime dependency: " + name + " " + deps[name]);
            process.exit(1);
        }
        const installed = JSON.parse(fs.readFileSync(manifest, "utf8"));
        if (installed.version !== deps[name]) {
            console.error("version mismatch for " + name + ": declared " + deps[name] + ", installed " + installed.version);
            process.exit(1);
        }
    }
    console.log("deps check: all " + Object.keys(deps).length + " runtime dependencies present at their declared versions");
  '';
  piSubagentsRunnerWiringCheck = pkgs.writeText "pi-subagents-runner-wiring-check.mjs" ''
    import * as fs from "node:fs";
    const runner = new URL("./pkg/src/runs/background/subagent-runner.js", import.meta.url);
    const src = fs.readFileSync(runner, "utf8");
    for (const match of src.matchAll(/\bfrom\s+["'](\.[^"']+)['"]/g)) {
        if (!fs.existsSync(new URL(match[1], runner))) {
            console.error("unresolved import in subagent-runner.js: " + match[1]);
            process.exit(1);
        }
    }
    const terminal = /if \(statusPayload\.timedOut \|\| statusPayload\.stopped\)/.exec(src);
    if (!terminal) {
        console.error("no terminal-run process-group kill guard in subagent-runner.js");
        process.exit(1);
    }
    const terminalCall = src.slice(terminal.index).indexOf("terminateOwnProcessGroup();");
    if (terminalCall === -1 || terminalCall > 400) {
        console.error("terminal-run block does not terminate the process group");
        process.exit(1);
    }
    const termHandler = src.indexOf('process.on("SIGTERM"');
    if (termHandler === -1) {
        console.error("no SIGTERM handler in subagent-runner.js");
        process.exit(1);
    }
    const handlerCall = src.slice(termHandler).indexOf("terminateOwnProcessGroup()");
    if (handlerCall === -1 || handlerCall > 400) {
        console.error("SIGTERM handler does not terminate the process group");
        process.exit(1);
    }
    const backstopCalls = src.match(/armGroupBackstop\(\);/g) ?? [];
    if (backstopCalls.length < 2) {
        console.error("group backstop not armed on stop and timeout: " + backstopCalls.length + " call(s)");
        process.exit(1);
    }
    const backstopDelay = /TERMINAL_GROUP_BACKSTOP_MS\s*=\s*([0-9][0-9_]*)/.exec(src);
    if (!backstopDelay || Number(backstopDelay[1].replace(/_/g, "")) < 10_000) {
        console.error("terminal group backstop delay must be at least 10s, got: " + (backstopDelay ? backstopDelay[1] : "missing"));
        process.exit(1);
    }
    console.log("runner wiring check: imports resolve and the terminal group kill is wired");
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

  extensionDir = ../modules/pi-coding-agent/extensions;
  extensionReadDir = builtins.readDir extensionDir;
  extensionTestFiles = nixpkgs.lib.filter (
    name: extensionReadDir.${name} == "regular" && nixpkgs.lib.hasSuffix ".test.mjs" name
  ) (nixpkgs.lib.attrNames extensionReadDir);
  discoveredExtensionChecks = builtins.listToAttrs (
    map (
      file:
      let
        name = "pi-extension-${nixpkgs.lib.removeSuffix ".test.mjs" file}";
      in
      nixpkgs.lib.nameValuePair name (
        pkgs.runCommand name
          {
            nativeBuildInputs = [ pkgs.nodejs ];
          }
          ''
            cp -r --no-preserve=mode ${extensionDir} extensions
            cd extensions
            node ${file}
            touch $out
          ''
      )
    ) extensionTestFiles
  );

  recipeChecks = import ../modules/agent-recipes/checks.nix {
    inherit pkgs;
    inherit (nixpkgs) lib;
    resolved =
      inputs.self.nixosConfigurations.redtruck.config.containers.devbox.config.home-manager.users.agent.mine.user.agent-recipes.resolved;
  };
in
nixpkgs.lib.foldl (a: b: a // b) { } [
  (evalAll "nixos" inputs.self.nixosConfigurations)
  (evalAll "darwin" inputs.self.darwinConfigurations)
  {
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
    pi-subagents-group-kill =
      pkgs.runCommand "pi-subagents-group-kill-check"
        {
          nativeBuildInputs = [
            pkgs.nodejs
            pkgs.procps
          ];
        }
        ''
          cp -r --no-preserve=mode ${piSubagents} pkg
          cp ${piSubagentsGroupKillCheck} group-kill-check.mjs
          cp ${piSubagentsGroupKillRunner} runner.mjs
          cp ${piSubagentsGroupKillBash} bash.mjs
          cp ${piSubagentsGroupKillOwnershipCheck} ownership-check.mjs
          cp ${piSubagentsGroupKillOwnershipChild} ownership-child.mjs
          cp ${piSubagentsDepsCheck} deps-check.mjs
          cp ${piSubagentsRunnerWiringCheck} runner-wiring-check.mjs
          node group-kill-check.mjs
          node ownership-check.mjs
          node deps-check.mjs
          node runner-wiring-check.mjs
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
  recipeChecks
  discoveredExtensionChecks
  (nixpkgs.lib.mapAttrs' (
    name: drv: nixpkgs.lib.nameValuePair "pkg-${name}" drv
  ) inputs.self.packages.x86_64-linux)
]
