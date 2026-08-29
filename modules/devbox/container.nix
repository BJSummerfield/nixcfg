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

  envContract = ./ENVIRONMENT.md;

  # Pi needs bun and node on PATH or plugins crash at startup; wrapped
  # here because the upstream home-manager module is disabled below.
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
      # Claude has no environment-contract equivalent, and the
      # appendSystemPromptFile settings key is inert on 2.1.234 - the
      # CLI flag is the only mechanism that works.
      args = ''--append-system-prompt "$(cat ${envContract})"'';
    })
    (mkAgent {
      name = "pi";
      real = "${piWrapped}/bin/pi";
    })
  ];

  # GH_TOKEN is injected at use time so it never lands in the nix store.
  # Wrapped rather than bare pkgs.gh - buildEnv fails on duplicate names.
  ghWrapped = pkgs.writeShellScriptBin "gh" ''
    export GH_TOKEN=$(cat /run/secrets/github-token)
    exec ${lib.getExe pkgs.gh} "$@"
  '';

  # Plugin membership for both agents (no versions); see the plugins.nix
  # header for the update commands and the escalation path.
  plugins = import ./plugins.nix;

  # Seeded with the one declared plugin enabled - membership only, no
  # version, so the id cannot go stale. Plugin state (marketplace clone,
  # cache, installed_plugins.json) is claude-owned; a rebuild re-seeds
  # this file only. Auth lives separately in .credentials.json.
  claudeSettings = pkgs.writeText "claude-settings.json" (
    builtins.toJSON {
      theme = "dark";
      inputNeededNotifEnabled = true;
      agentPushNotifEnabled = true;
      enabledPlugins = {
        "${plugins.claudePluginId}" = true;
      };
    }
  );
in
{
  imports = [
    inputs.home-manager.nixosModules.home-manager
    inputs.paseo.nixosModules.paseo
    ../unfree/nixos.nix
  ];

  # uid pinned outside the host uid range so nix-daemon treats the agent as
  # untrusted (no extra-sandbox-paths), while still allowing builds.
  users.users.agent = {
    isNormalUser = true;
    uid = 1500;
    home = "/home/agent";
    description = "coding agent";
  };

  # Builds go through the host daemon; the store is shared read-only.
  # Pin the registry so `nix shell nixpkgs#foo` resolves against the shared
  # host store instead of fetching nixos-unstable over the network.
  nix.settings.experimental-features = [
    "nix-command"
    "flakes"
  ];
  nix.registry.nixpkgs.flake = inputs.nixpkgs;
  nix.nixPath = [ "nixpkgs=flake:nixpkgs" ];

  mine.allowedUnfree = [ "claude-code" ];

  # Also on the system PATH: the paseo daemon's inheritUserEnvironment may
  # not pick up /etc/profiles/per-user/agent/bin, and a daemon that cannot
  # find `claude` fails with no hint why.
  environment.systemPackages =
    agentPkgs
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
          ../pi-coding-agent/home.nix
        ];
        home.stateVersion = "26.05";

        mine.user = {
          direnv.enable = true;
          pi-coding-agent.enable = true;
        };

        # Suppresses the upstream module's own bin/pi - it would collide with
        # the mkAgent wrapper of the same name in this profile (buildEnv
        # fails hard on same-name paths of equal priority). Settings/config
        # generation from the module is untouched; only the package is
        # disabled.
        programs.pi-coding-agent.package = null;

        # Paseo creates worktrees under its dataDir, so per-repo `direnv
        # allow` can never cover them; the agent runs arbitrary code by
        # design, and the container is the boundary.
        programs.direnv.config.whitelist.prefix = [
          "/home/agent/projects"
          "/var/lib/paseo/worktrees"
        ];

        home.packages = agentPkgs;
        home.file.".pi/agent/APPEND_SYSTEM.md".source = envContract;

        # git signs via `ssh-keygen -Y sign`, which takes a key file, not an
        # agent - these settings are the whole mechanism. Gated on
        # signCommits as one unit: gpgSign on with no key present makes git
        # refuse to commit at all.
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
            # or the nix store; a GitHub ruleset, not the token, stops a
            # push to a protected branch.
            credential."https://github.com".helper =
              "!f() { echo username=x-access-token; echo password=$(cat /run/secrets/github-token); }; f";
          }
          // lib.optionalAttrs signCommits {
            gpg.format = "ssh";
            commit.gpgSign = true;
          };
        };

        # Copied, not linked: Claude rewrites settings.json, and a store
        # symlink would make that write fail with EROFS. `rm` before
        # `install` because install(1) follows an existing symlink to its
        # read-only target - and because the file already exists unmanaged
        # in every running container.
        #
        # Anything Claude itself writes to settings.json is reset on the
        # next activation - including user-scope `permissions` rules.
        # Anything durable belongs in a project's own .claude/settings.json.
        # Deliberate: a container must never come up with a plugin enabled
        # - or a permission granted - that this config did not ask for.
        home.activation.claudeSettings = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
          run mkdir -p $VERBOSE_ARG "$HOME/.claude-state"
          run rm -f $VERBOSE_ARG "$HOME/.claude-state/settings.json"
          run install $VERBOSE_ARG -m 0644 ${claudeSettings} \
            "$HOME/.claude-state/settings.json"
        '';

        # Superpowers plugin state for Claude is claude-owned, not seeded:
        # seeding the marketplace clone, plugin cache or installed_plugins
        # .json from the store would be read-only litter claude's rewrites
        # die against (the same EROFS failure mode as above), and a pinned
        # version would go stale between rebuilds. Nix owns only the
        # enabledPlugins entry in the settings seed (membership, no
        # version).
      };
  };

  services.paseo = {
    enable = true;
    user = "agent";
    group = "users";
    port = 6767;
    # Never leaves loopback; `tailscale serve` is the only door, so
    # nothing on the LAN and nothing on ve-devbox can reach the daemon.
    listenAddress = "127.0.0.1";
    openFirewall = false;
    # No third party in the path; the tailnet is the transport. A broken
    # tailnet locks the environment out entirely, as with every other
    # service on it.
    relay.enable = false;
    # Must match what `tailscale serve` publishes or requests are
    # rejected on the Host header — mismatch causes 400 errors.
    hostnames = [ tailnetHostname ];
    dataDir = "/var/lib/paseo";
    # System service doesn't inherit sessionVariables; duplicated from
    # sessionVariables to prevent drift - an unset var makes agents read the
    # wrong config.
    environment = {
      CLAUDE_CONFIG_DIR = "/home/agent/.claude-state";
      DISABLE_AUTOUPDATER = "1";
      # Web UI is off by default; without this, `tailscale serve` proxies to
      # a 404 and looks like a routing problem. Env var rather than settings
      # because the daemon also persists state into config.json.
      PASEO_WEB_UI_ENABLED = "true";
    };
  };

  # Tailnet membership is not sufficient authentication on its own. The
  # upstream module has no environmentFile-style option - the value would
  # pass through cfg.environment/cfg.settings, which the module renders
  # into the world-readable nix store. Overriding the generated unit's
  # EnvironmentFile directly is the only way to hand the daemon a secret
  # that never touches the store.
  systemd.services.paseo.serviceConfig.EnvironmentFile = "/run/secrets/paseo-password";

  # Without this check a malformed paseo-password would leave paseo
  # running unauthenticated on the tailnet with no failure anywhere:
  # the password is only installed when PASEO_PASSWORD is non-empty, and
  # systemd only logs a warning for a malformed EnvironmentFile= line -
  # the unit still comes up "active". A missing `=` is the natural
  # mistake, since the container's other secret is a bare-value file.
  # This turns it into a hard startup failure.
  #
  # Runs with "+" (root): the password file is deliberately root-only
  # (mode = "0400", see mine.system.devboxes.<name>.paseoPasswordFile),
  # and an unprefixed ExecStartPre runs as the unit's User=agent, which
  # could not read it. Uses grep's exit status only; never echoes the
  # file's contents, so the secret can't reach the unit's stderr/journal.
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

  # Declarative join and serve are flaky on nspawn containers; the
  # manual one-time ritual (see nixos.nix header) is used instead.
  services.tailscale.enable = true;

  networking = {
    # No host resolv.conf in the container; needed for the tailscale
    # control plane and for agents fetching from the network.
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

  systemd.tmpfiles.rules = [
    "d /home/agent/projects 0755 agent users -"
    # Created ahead of time so the glob below and the path unit's watch
    # both have something to see from boot, not only after the first
    # worktree is ever created.
    "d /var/lib/paseo/worktrees 0755 agent users -"
  ];

  # Builds every repo's and worktree's devShell ahead of first use, so an
  # agent launched from a phone never blocks on a cold `nix develop`.
  # nix-direnv creates GC roots, so a warmed shell survives
  # nix-collect-garbage.
  systemd.services.devbox-warm = {
    description = "Warm direnv devShells for all devbox projects and worktrees";
    # `use flake` comes from nix-direnv's direnvrc, which home-manager
    # writes out during activation; without this ordering the path unit can
    # fire before that on first boot, and every repo fails warming with an
    # unhelpful "unknown command: use flake".
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
      # Paseo (0.3.0-beta.4) lays worktrees out as
      # worktrees/<projectHash>/<slug> - an extra level keyed by a hash of
      # the source repo, not worktrees/<slug> directly. Hence the double
      # */*/ below.
      for repo in /home/agent/projects/*/ /var/lib/paseo/worktrees/*/*/; do
        [ -f "$repo/.envrc" ] || continue
        cd "$repo" || continue
        echo "warming $repo"
        # nix-direnv fails open: a flake that will not build still exits 0,
        # so `grep -q '^error:'` detects it; same detection as
        # modules/devbox/agents.nix.
        #
        # `&& rc=0 || rc=$?` rather than `; rc=$?`: NixOS's systemd `script`
        # wrapper prepends `set -e`, under which the bare form aborts the
        # whole unit on the first broken repo - the AND-OR form is exempt
        # from errexit and preserves per-repo isolation.
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
  # Necessarily incomplete: PathChanged= takes a literal directory, not a
  # glob, and is not recursive (only PathExistsGlob= globs, and that is an
  # existence check, not a change notification). A 2nd+ worktree of the same
  # project only mutates worktrees/<projectHash>/, one level down, which
  # nothing here watches (hashes aren't known ahead of time, so there is no
  # fixed set of literal paths to list). Per-hash path units or a polling
  # watcher would be disproportionate; the hourly devbox-warm timer below is
  # the backstop that bounds the staleness instead.
  systemd.paths.devbox-warm = {
    description = "Watch devbox projects and worktrees for new or changed flakes";
    wantedBy = [ "multi-user.target" ];
    pathConfig.PathChanged = [
      "/home/agent/projects"
      "/var/lib/paseo/worktrees"
    ];
  };

  # Backstop. Covers flake.lock edits made inside an existing repo (which
  # the path unit's directory watch never sees), and - per the comment on
  # systemd.paths.devbox-warm above - is also the only thing that warms a
  # 2nd+ worktree of an existing project. Daily was too coarse: a phone
  # task would block on a cold `nix develop` for up to a day; hourly is a
  # cheap no-op on already-warmed shells.
  systemd.timers.devbox-warm = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = "hourly";
      Persistent = true;
    };
  };

  system.stateVersion = "26.05";
}
