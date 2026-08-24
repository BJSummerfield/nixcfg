# NixOS configuration for the devbox container.
# Tailnet join and serve are manual — see nixos.nix.
{
  inputs,
  tailnetHostname,
  gitIdentity,
  signCommits,
}:
{
  config,
  pkgs,
  lib,
  ...
}:
let
  inherit (import ./agents.nix { inherit pkgs lib; }) mkAgent;

  # Pi needs bun and node on PATH or plugins crash at startup.
  # Wrapped here because the upstream module is disabled below.
  piWrapped = pkgs.symlinkJoin {
    name = "pi-wrapped";
    paths = [ pkgs.pi-coding-agent ];
    nativeBuildInputs = [ pkgs.makeWrapper ];
    postBuild = ''
      wrapProgram $out/bin/pi --suffix PATH : ${lib.makeBinPath (import ../pi-coding-agent/extra-packages.nix pkgs)}
    '';
  };

  agentPkgs = [
    (mkAgent {
      name = "claude";
      real = lib.getExe pkgs.claude-code;
    })
    (mkAgent {
      name = "pi";
      real = "${piWrapped}/bin/pi";
    })
    (mkAgent {
      name = "opencode";
      real = lib.getExe pkgs.opencode;
    })
  ];

  # Wrapped to inject GH_TOKEN at use time so it never lands in the nix store.
  # Replaces bare pkgs.gh — pkgs.buildEnv fails on duplicate names.
  ghWrapped = pkgs.writeShellScriptBin "gh" ''
    export GH_TOKEN=$(cat /run/secrets/github-token)
    exec ${lib.getExe pkgs.gh} "$@"
  '';

  agentSkills = import ./skills.nix pkgs;

  # Fan-out tiers. These replace pi-superagents' modelTiers: pi's own CLI
  # takes provider/id:thinking, which is exactly what that config resolved.
  #
  # Strictly read-only - deliberately no `bash`, which is a write vector
  # regardless of the other tools (a child given bash creates files with
  # `echo >`). The parent does all git and gh work and hands children a
  # pre-materialised diff path.
  #
  # `-ns` because a child is given its instructions directly; it should not
  # pay for the whole skill-description block. Calls piWrapped rather than
  # the mkAgent `pi` on PATH so a child does not re-enter direnv, which the
  # parent has already loaded.
  mkTier =
    {
      name,
      model,
      thinking,
    }:
    pkgs.writeShellScriptBin name ''
      exec ${piWrapped}/bin/pi -p \
        --model ${model}:${thinking} \
        --tools read,grep,find,ls \
        --no-session -ns "$@"
    '';

  tierPkgs = [
    (mkTier {
      name = "pi-cheap";
      model = "redtruck/Qwen3.8-27B-NVFP4-48k";
      thinking = "medium";
    })
    (mkTier {
      name = "pi-max";
      model = "redtruck/Qwen3.8-27B-NVFP4";
      thinking = "xhigh";
    })
  ];

  # Claude keeps plugins and preferences in one small file. Generated with
  # enabledPlugins empty so a container never comes up with Superpowers on.
  # Auth lives separately in .credentials.json and is untouched.
  claudeSettings = pkgs.writeText "claude-settings.json" (
    builtins.toJSON {
      theme = "dark";
      inputNeededNotifEnabled = true;
      agentPushNotifEnabled = true;
      enabledPlugins = { };
    }
  );
in
{
  imports = [
    inputs.home-manager.nixosModules.home-manager
    inputs.paseo.nixosModules.paseo
    ../unfree/nixos.nix
  ];

  ##########################################################################
  # user + agents + home-manager
  ##########################################################################

  # Pinned outside the host uid range so nix-daemon treats the agent as
  # untrusted (no extra-sandbox-paths), while still allowing builds.
  users.users.agent = {
    isNormalUser = true;
    uid = 1500;
    home = "/home/agent";
    description = "coding agent";
  };

  # nix builds go through the host daemon; the store is shared read-only.
  # Pin the registry so `nix shell nixpkgs#foo` (promised by the design as
  # available inside agent sessions) resolves against the shared host store
  # instantly instead of fetching nixos-unstable over the network.
  nix.settings.experimental-features = [
    "nix-command"
    "flakes"
  ];
  nix.registry.nixpkgs.flake = inputs.nixpkgs;
  nix.nixPath = [ "nixpkgs=flake:nixpkgs" ];

  mine.allowedUnfree = [ "claude-code" ];

  # Also on the system PATH, not only in the user profile: the paseo
  # daemon's inheritUserEnvironment may or may not pick up
  # /etc/profiles/per-user/agent/bin, and a daemon that cannot find
  # `claude` fails in a way that gives no hint why.
  environment.systemPackages =
    agentPkgs
    ++ tierPkgs
    ++ [ ghWrapped ]
    ++ (with pkgs; [
      curl
      fd
      jq
      ripgrep
      git
      direnv
    ]);

  environment.sessionVariables = {
    CLAUDE_CONFIG_DIR = "/home/agent/.claude-state";
    DISABLE_AUTOUPDATER = "1";
  };

  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    users.agent =
      { lib, ... }:
      {
        imports = [
          ../direnv/home.nix
          ../opencode/home.nix
          ../pi-coding-agent/home.nix
        ];
        home.stateVersion = "26.05";

        mine.user = {
          direnv.enable = true;
          opencode.enable = true;
          pi-coding-agent.enable = true;
        };

        # Suppresses the upstream modules' own bin/pi and bin/opencode -
        # otherwise they collide with the mkAgent wrappers of the same name
        # in this same home-manager profile (pkgs.buildEnv fails hard on
        # same-name paths of equal priority). Settings/config generation
        # from these modules is untouched; only the package is disabled.
        programs.pi-coding-agent.package = null;
        programs.opencode.package = null;

        # Paseo creates worktrees under its dataDir, so per-repo `direnv allow`
        # can never cover them. Whitelisting both trees — agent runs arbitrary
        # code by design, and the container is the boundary.
        programs.direnv.config.whitelist.prefix = [
          "/home/agent/projects"
          "/var/lib/paseo/worktrees"
        ];

        home.packages = agentPkgs ++ tierPkgs;
        home.file.".pi/agent/APPEND_SYSTEM.md".source = ../pi-coding-agent/APPEND_SYSTEM.md;

        # Both agents read the same flattened tree. Read-only store symlinks
        # are correct: neither writes skill files.
        home.file.".pi/agent/skills".source = agentSkills;
        home.file.".claude-state/skills".source = agentSkills;

        # git signs via `ssh-keygen -Y sign`, which takes a key file, not an
        # agent — so these settings are the whole mechanism. All three are
        # gated on signCommits as one unit: gpgSign left on without a key
        # present makes git refuse to commit at all, which is worse than an
        # instance that simply does not sign.
        programs.git = {
          enable = true;
          settings = {
            user = {
              inherit (gitIdentity) name email;
            }
            // lib.optionalAttrs signCommits {
              signingkey = "/run/secrets/signing-key";
            };
            # Reads the token at use time so it never lands in a config file
            # or the nix store. The token bounds which repos are reachable;
            # a GitHub ruleset is what stops a push to a protected branch.
            credential."https://github.com".helper =
              "!f() { echo username=x-access-token; echo password=$(cat /run/secrets/github-token); }; f";
          }
          // lib.optionalAttrs signCommits {
            gpg.format = "ssh";
            commit.gpgSign = true;
          };
        };

        # Copied, not linked: Claude rewrites settings.json (theme changes,
        # plugin toggles), and a store symlink would make that write fail
        # with EROFS. `rm` before `install` because install(1) follows an
        # existing symlink to its read-only target - and because the file
        # already exists unmanaged in every running container.
        home.activation.claudeSettings = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
          run mkdir -p $VERBOSE_ARG "$HOME/.claude-state"
          run rm -f $VERBOSE_ARG "$HOME/.claude-state/settings.json"
          run install $VERBOSE_ARG -m 0644 ${claudeSettings} \
            "$HOME/.claude-state/settings.json"
        '';
      };
  };

  ##########################################################################
  # paseo
  ##########################################################################

  services.paseo = {
    enable = true;
    user = "agent";
    group = "users";
    port = 6767;
    # Never leaves loopback. `tailscale serve` is the only door, so
    # nothing on the LAN and nothing on ve-devbox can reach the daemon.
    listenAddress = "127.0.0.1";
    openFirewall = false;
    # No third party in the path; the tailnet is the transport. Cost is
    # that a broken tailnet locks the environment out entirely, which is
    # how every other service on this tailnet already behaves.
    relay.enable = false;
    # Must match what `tailscale serve` publishes or requests are
    # rejected on the Host header — mismatch causes 400 errors.
    hostnames = [ tailnetHostname ];
    dataDir = "/var/lib/paseo";
    # System service doesn't inherit sessionVariables; duplicated from
    # sessionVariables to prevent drift. Unset var makes agents read wrong config.
    environment = {
      CLAUDE_CONFIG_DIR = "/home/agent/.claude-state";
      DISABLE_AUTOUPDATER = "1";
      # Web UI is off by default; without this, `tailscale serve` proxies
      # to a 404 and looks like a routing problem. Uses env var instead of
      # settings because the daemon also persists state into config.json.
      PASEO_WEB_UI_ENABLED = "true";
    };
  };

  # Tailnet membership is not treated as sufficient authentication on its
  # own (see mine.system.devboxes.<name>.paseoPasswordFile). Upstream's paseo module
  # has no environmentFile-style option to consume this without the value
  # passing through cfg.environment/cfg.settings - both of which the
  # module renders into the nix store, which is world-readable. Overriding
  # the generated unit's EnvironmentFile directly is the only way to hand
  # the daemon a secret that never touches the store.
  systemd.services.paseo.serviceConfig.EnvironmentFile = "/run/secrets/paseo-password";

  # paseo's resolveAuthConfig (server/dist/server/server/config.js) only
  # installs a password when PASEO_PASSWORD is non-empty; otherwise it
  # silently falls back to persisted config or no auth at all. Meanwhile
  # systemd only *logs a warning* for an EnvironmentFile= line missing an
  # `=` - the unit still comes up "active". So a malformed
  # paseo-password (wrong key, stray whitespace, empty value - the natural
  # mistake, since the container's other secret is a bare-value file, not a
  # KEY=value one) would leave paseo running unauthenticated on the tailnet
  # with no failure anywhere. This turns that into a hard startup failure
  # instead.
  #
  # Runs with the "+" prefix - i.e. as root, not the unit's own
  # User=agent - because paseoPasswordFile is deliberately root-only
  # (mode = "0400", see mine.system.devboxes.<name>.paseoPasswordFile);
  # ExecStartPre without "+" runs as the unit's configured User=, which could
  # not read it. Uses grep's own exit status only; never echoes the file's
  # contents, matched or not, so the secret can't reach the unit's
  # stderr/journal.
  systemd.services.paseo.serviceConfig.ExecStartPre = [
    (
      "+"
      + toString (
        pkgs.writeShellScript "paseo-password-check" ''
          if ! ${lib.getExe pkgs.gnugrep} -Eq '^PASEO_PASSWORD=.+' /run/secrets/paseo-password; then
            echo "paseo-password: no non-empty PASEO_PASSWORD=<value> line found - refusing to start paseo unauthenticated (value withheld)" >&2
            exit 1
          fi
        ''
      )
    )
  ];

  ##########################################################################
  # tailscale (firewall only - join and serve are manual, see nixos.nix)
  ##########################################################################

  # Declarative join and serve are flaky on nspawn containers.
  # Manual one-time ritual is used instead — see nixos.nix header.
  services.tailscale.enable = true;

  networking = {
    # container has no host resolv.conf; needed for the tailscale
    # control plane and for agents fetching from the network
    nameservers = [
      "9.9.9.9"
      "1.1.1.1"
    ];
    firewall = {
      enable = true;
      trustedInterfaces = [ "tailscale0" ];
      allowedUDPPorts = [ config.services.tailscale.port ];
    };
  };

  ##########################################################################
  # warming (tmpfiles + service + path + timer)
  ##########################################################################

  systemd.tmpfiles.rules = [
    "d /home/agent/projects 0755 agent users -"
    # paseo creates worktrees here at runtime; created ahead of time so the
    # glob below and the path unit's watch both have something to see from
    # boot, rather than only after the first worktree is ever created.
    "d /var/lib/paseo/worktrees 0755 agent users -"
  ];

  # Builds every repo's (and every worktree's) devShell ahead of first use,
  # so an agent launched from a phone never blocks on a cold `nix develop`.
  # nix-direnv creates GC roots, so a warmed shell survives
  # nix-collect-garbage.
  systemd.services.devbox-warm = {
    description = "Warm direnv devShells for all devbox projects and worktrees";
    # `use flake` comes from nix-direnv's direnvrc, which home-manager
    # writes out during activation. Without this ordering the path unit
    # can fire before that activation on first boot, and every repo fails
    # warming with an unhelpful "unknown command: use flake".
    after = [ "home-manager-agent.service" ];
    wants = [ "home-manager-agent.service" ];
    serviceConfig = {
      Type = "oneshot";
      User = "agent";
      # A cold build of several repos is slow and must not be killed
      # halfway, leaving a partially-realised shell.
      TimeoutStartSec = "2h";
    };
    path = with pkgs; [
      direnv
      nix
      git
    ];
    script = ''
      shopt -s nullglob
      # Paseo (0.3.0-beta.4, server/dist/server/utils/worktree.js) lays worktrees
      # out as $PASEO_HOME/worktrees/<projectHash>/<slug> - an extra directory
      # level keyed by a hash of the source repo root, not
      # worktrees/<slug> directly. Hence the double */*/ below.
      for repo in /home/agent/projects/*/ /var/lib/paseo/worktrees/*/*/; do
        [ -f "$repo/.envrc" ] || continue
        cd "$repo" || continue
        echo "warming $repo"
        # nix-direnv fails open: a flake that will not build still exits 0
        # here. Trusting $? would log nothing and warm nothing, silently.
        # Same detection as modules/devbox/agents.nix.
        #
        # `&& rc=0 || rc=$?` rather than `; rc=$?`: NixOS's systemd
        # `script` wrapper prepends `set -e`, under which a bare
        # `err=$(failing-cmd); rc=$?` aborts the whole unit on the first
        # broken repo before `rc=$?` is even reached - the AND-OR form is
        # exempt from errexit and is required to preserve per-repo
        # isolation.
        err=$(direnv exec . true 2>&1 >/dev/null) && rc=0 || rc=$?
        if [ "$rc" -ne 0 ]; then
          echo "warming failed for $repo:" >&2
          printf '%s\n' "$err" >&2
        elif printf '%s' "$err" | grep -q '^error:'; then
          echo "devShell build failed for $repo:" >&2
          printf '%s\n' "$err" >&2
        fi
      done
    '';
  };

  # Fires when a repo or worktree appears, or its flake changes.
  #
  # This watch is necessarily incomplete: systemd.path's PathChanged= takes a
  # literal directory, not a glob, and is not recursive (see systemd.path(5)
  # - only PathExistsGlob= globs, and it is an existence check, not a change
  # notification). Watching /var/lib/paseo/worktrees therefore only ever
  # sees a project's *first* worktree, which is what creates the
  # <projectHash> directory directly inside it; a 2nd+ worktree of the same
  # project only mutates worktrees/<projectHash>/, one level down, which
  # nothing here is watching (project hashes aren't known ahead of time, so
  # there is no fixed set of literal paths to list). Closing that requires
  # either dynamically generated per-hash path units or dropping inotify for
  # a polling watcher - both disproportionate to what this gap costs. The
  # devbox-warm timer below is shortened from a daily to an hourly backstop
  # specifically to bound that staleness instead.
  systemd.paths.devbox-warm = {
    description = "Watch devbox projects and worktrees for new or changed flakes";
    wantedBy = [ "multi-user.target" ];
    pathConfig.PathChanged = [
      "/home/agent/projects"
      "/var/lib/paseo/worktrees"
    ];
  };

  # Backstop. Originally just for flake.lock edits made inside an existing
  # repo (which the path unit's directory watch never sees at all), but also
  # now the only thing that ever warms a 2nd+ worktree of an existing
  # project - see the comment on systemd.paths.devbox-warm above. Daily was
  # too coarse for that case: the whole point of warming is that a task
  # launched from a phone must not block on a cold `nix develop`, and up to
  # a day of staleness on every second task in a project defeats that.
  # Hourly is cheap here - direnv exec on an already-warmed shell is a fast
  # no-op - and bounds the gap to something that no longer matters in
  # practice.
  systemd.timers.devbox-warm = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = "hourly";
      Persistent = true;
    };
  };

  system.stateVersion = "26.05";
}
