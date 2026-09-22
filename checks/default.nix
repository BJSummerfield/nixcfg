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

  # mkForce: `profiles` is a merging attrset option and the diff covers the
  # WHOLE tree, so the real catalog would read as unexpected entries.
  devbox-hermes-profiles =
    let
      pluginSrc = ../modules/devbox/hermes-plugins/least-privilege-toolsets;
      withProfiles = inputs.self.nixosConfigurations.redtruck.extendModules {
        modules = [
          {
            mine.system.devboxes.devbox.hermesEnvFile = "/run/secrets/devbox-hermes-env";
            containers.devbox.config.mine.hermes.agentProfiles.profiles = nixpkgs.lib.mkForce {
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
        plugins:
          enabled:
          - least-privilege-toolsets
        terminal:
          cwd: /home/agent/projects
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
        plugins:
          enabled:
          - least-privilege-toolsets
        terminal:
          cwd: /home/agent/projects
        EOF
        printf 'CLAUDE_CONFIG_DIR=/home/agent/.claude-state\n' > $out/profiles/check-claude/.env

        # Every profile is its own HERMES_HOME: the root plugin install is invisible to it.
        for p in check-local check-claude; do
          install -D ${pluginSrc}/__init__.py $out/profiles/$p/plugins/least-privilege-toolsets/__init__.py
          install -D ${pluginSrc}/plugin.yaml $out/profiles/$p/plugins/least-privilege-toolsets/plugin.yaml
        done
      '';
    in
    pkgs.runCommand "devbox-hermes-profiles" { } ''
      diff -ru ${expected} ${tree}
      touch $out
    '';

  devbox-hermes-profiles-catalog =
    let
      inherit (nixpkgs) lib;
      catalog = import ../modules/devbox/hermes-profiles-catalog.nix;
      roles = [
        "orchestrator"
        "scout"
        "worker"
        "verifier"
        "reviewer"
        "oracle"
      ];
      families = {
        claude = "anthropic";
        qwen = "local";
      };
      knownToolsets = [
        "readonly"
        "verify"
        "web"
        "search"
        "vision"
        "terminal"
        "skills"
        "browser"
        "file"
        "todo"
        "memory"
        "code_execution"
        "delegation"
        "kanban"
        "clarify"
        "chat_history_lookup"
        "cronjob"
        "computer_use"
        "safe"
        "coding"
        "debugging"
      ];
      readOnlyRoles = [
        "orchestrator"
        "scout"
        "reviewer"
        "oracle"
      ];
      expectedNames = lib.concatMap (f: map (r: "${f}-${r}") roles) (lib.attrNames families);
      actualNames = lib.attrNames catalog;

      failures =
        lib.optional (
          lib.sort lib.lessThan actualNames != lib.sort lib.lessThan expectedNames
        ) "profile set is ${toString actualNames}, expected ${toString expectedNames}"
        ++ lib.concatMap (
          name:
          let
            p = catalog.${name};
            family = lib.head (lib.splitString "-" name);
            role = lib.removePrefix "${family}-" name;
            toolsets = p.toolsets or [ ];
            disabled = p.disabledToolsets or [ ];
            grants = t: lib.elem t toolsets;
          in
          lib.optional (
            p.backend != families.${family}
          ) "${name}: backend ${p.backend}, expected ${families.${family}} for the ${family} family"
          ++ lib.optional (!(p ? model) || p.model == null) "${name}: no model id"
          ++ lib.optional (!(p ? description)) "${name}: no description for the decomposer to route on"
          ++ lib.optional (
            !lib.elem p.thinking [
              "medium"
              "xhigh"
            ]
          ) "${name}: thinking ${p.thinking}, expected medium or xhigh"
          ++ map (t: "${name}: unknown toolset ${t}") (lib.subtractLists knownToolsets toolsets)
          ++ map (t: "${name}: unknown disabled toolset ${t}") (lib.subtractLists knownToolsets disabled)
          ++ lib.optional (
            lib.elem role readOnlyRoles && grants "file"
          ) "${name}: read-only role granted the indivisible `file` toolset, which can write"
          ++ lib.optional (
            lib.elem role readOnlyRoles && grants "terminal"
          ) "${name}: read-only role granted `terminal`"
          ++ lib.optional (
            lib.elem role readOnlyRoles && !lib.elem "code_execution" disabled
          ) "${name}: read-only role must disable `code_execution`, whose sandbox writes and runs commands"
          ++ lib.optional (
            role == "verifier" && !grants "verify"
          ) "${name}: verifier must use the `verify` toolset"
          ++ lib.optional (role == "verifier" && grants "file") "${name}: verifier must not grant `file`"
          ++ lib.optional (
            role == "reviewer" && !grants "readonly"
          ) "${name}: reviewer must use the `readonly` toolset"
          ++ lib.optional (
            role == "worker" && !(grants "file" && grants "terminal")
          ) "${name}: worker is the implementing role and needs both `file` and `terminal`"
          ++ lib.optional (
            role == "orchestrator" && !(grants "kanban" && grants "delegation")
          ) "${name}: orchestrator dispatches and needs `kanban` and `delegation`"
        ) actualNames;
    in
    if failures != [ ] then
      throw "hermes-profiles-catalog:\n  ${lib.concatStringsSep "\n  " failures}"
    else
      pkgs.runCommand "devbox-hermes-profiles-catalog" { } "touch $out";
  # Both halves of the wiring: either alone is a silent no-op.
  devbox-hermes-plugins =
    let
      withHermes = inputs.self.nixosConfigurations.redtruck.extendModules {
        modules = [
          { mine.system.devboxes.devbox.hermesEnvFile = "/run/secrets/devbox-hermes-env"; }
        ];
      };
      hermes = withHermes.config.containers.devbox.config.services.hermes-agent;
      plugin = builtins.head hermes.extraPlugins;

      # A profile is its own HERMES_HOME, so the root install reaches none of
      # them: discovery scans <home>/plugins and reads <home>/config.yaml.
      profiles = nixpkgs.lib.attrNames (import ../modules/devbox/hermes-profiles-catalog.nix);
      lacksPlugin = nixpkgs.lib.filter (
        p: !(hermes.hermesHomeFiles ? "profiles/${p}/plugins/least-privilege-toolsets/__init__.py")
      ) profiles;
      profileConfigs = map (p: hermes.hermesHomeFiles."profiles/${p}/config.yaml") profiles;
    in
    assert profiles != [ ];
    assert nixpkgs.lib.assertMsg (lacksPlugin == [ ])
      "profiles ${toString lacksPlugin} have no plugin under their own HERMES_HOME; readonly/verify would resolve to no tools there";
    pkgs.runCommand "devbox-hermes-plugins"
      {
        nativeBuildInputs = [ (pkgs.python3.withPackages (ps: [ ps.pyyaml ])) ];
        enabledJson = builtins.toJSON hermes.settings.plugins.enabled;
      }
      ''
        for cfg in ${nixpkgs.lib.concatStringsSep " " (map toString profileConfigs)}; do
          grep -q 'least-privilege-toolsets' "$cfg" || {
            echo "$cfg does not enable the plugin in its own config.yaml" >&2; exit 1; }
          grep -q 'cwd: /home/agent/projects' "$cfg" || {
            echo "$cfg did not inherit terminal.cwd from the root settings" >&2; exit 1; }
        done


        [ "$enabledJson" = '["least-privilege-toolsets"]' ] || {
          echo "plugins.enabled is $enabledJson" >&2; exit 1; }

        # The allow-list matches the manifest name, not the directory name.
        python3 -c '
        import json, sys, yaml
        name = yaml.safe_load(open("${plugin}/plugin.yaml"))["name"]
        assert name in json.loads(sys.argv[1]), f"{name} is not in plugins.enabled"
        ' "$enabledJson"

        test -f ${plugin}/__init__.py
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
