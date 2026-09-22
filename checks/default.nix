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

  # No annotations in the lines themselves (systemd journal lines never have
  # any): the base sample from the plan (a join, a death, a respawn, a
  # version-mismatch failed join, a leave), plus a second player who
  # actually joins after the first player's respawn, to prove the "a
  # respawn of an already-joined name is ignored" rule doesn't also
  # swallow a genuine later join.
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
  devbox-hermes =
    evalOnly "devbox-hermes"
      (inputs.self.nixosConfigurations.redtruck.extendModules {
        modules = [
          { mine.system.devboxes.devbox.hermesEnvFile = "/run/secrets/devbox-hermes-env"; }
        ];
      }).config.system.build.toplevel.drvPath;

  # The profile catalog is data, and an empty one renders nothing, so nothing
  # in the host config exercises the generator. This check declares one profile
  # per backend and diffs the rendered profiles/ tree, which pins both the file
  # layout Hermes reads and the derivations: the context_length taken from the
  # model alias, the thinkingLevels collapse (high -> xhigh), and the
  # CLAUDE_CONFIG_DIR that an anthropic profile needs to find any credential at
  # all.
  devbox-hermes-profiles =
    let
      withProfiles = inputs.self.nixosConfigurations.redtruck.extendModules {
        modules = [
          {
            mine.system.devboxes.devbox.hermesEnvFile = "/run/secrets/devbox-hermes-env";
            containers.devbox.config.mine.hermes.agentProfiles.profiles = {
              check-local = {
                description = "Check fixture.";
                model = "Qwen3.8-27B-NVFP4-32k";
                thinking = "high";
                toolsets = [
                  "file"
                  "skills"
                ];
                disabledToolsets = [ "browser" ];
              };
              check-claude = {
                backend = "anthropic";
                model = "claude-opus-4-6";
                thinking = "high";
              };
            };
          }
        ];
      };
      files = withProfiles.config.containers.devbox.config.services.hermes-agent.hermesHomeFiles;
      # hermesHomeFiles values are paths or inline strings; both must land on
      # disk before they can be diffed.
      materialize =
        value:
        if builtins.isPath value || pkgs.lib.isStorePath value then
          value
        else
          pkgs.writeText "hermes-home-file" value;
      tree = pkgs.runCommand "hermes-profiles-tree" { } (
        "mkdir -p $out\n"
        + nixpkgs.lib.concatStringsSep "\n" (
          nixpkgs.lib.mapAttrsToList (name: value: "install -D ${materialize value} $out/${name}") files
        )
      );
      expected = pkgs.runCommand "hermes-profiles-expected" { } ''
        mkdir -p $out/profiles/check-local $out/profiles/check-claude
        cat > $out/profiles/check-local/config.yaml <<'EOF'
        %YAML 1.1
        ---
        agent:
          disabled_toolsets:
          - browser
          reasoning_effort: xhigh
        model:
          api_key: local
          base_url: https://llm.mist-gamma.ts.net:8443/v1
          context_length: 98304
          default: Qwen3.8-27B-NVFP4-32k
          provider: custom
        platform_toolsets:
          cli:
          - file
          - skills
        EOF
        cat > $out/profiles/check-local/profile.yaml <<'EOF'
        %YAML 1.1
        ---
        description: Check fixture.
        description_auto: false
        EOF
        cat > $out/profiles/check-claude/config.yaml <<'EOF'
        %YAML 1.1
        ---
        agent:
          reasoning_effort: high
        model:
          default: claude-opus-4-6
          provider: anthropic
        EOF
        printf 'CLAUDE_CONFIG_DIR=/home/agent/.claude-state\n' > $out/profiles/check-claude/.env
      '';
    in
    pkgs.runCommand "devbox-hermes-profiles" { } ''
      diff -ru ${expected} ${tree}
      touch $out
    '';
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
//
  nixpkgs.lib.mapAttrs'
    (
      name: cfg:
      nixpkgs.lib.nameValuePair "caddyfile-${name}" (
        pkgs.runCommand "caddyfile-${name}"
          {
            nativeBuildInputs = [ cfg.config.services.caddy.package ];
          }
          ''
            HOME=$TMPDIR caddy adapt \
              --config ${cfg.config.services.caddy.configFile} \
              --adapter caddyfile > $out
          ''
      )
    )
    (nixpkgs.lib.filterAttrs (_: cfg: cfg.config.services.caddy.enable) inputs.self.nixosConfigurations)
