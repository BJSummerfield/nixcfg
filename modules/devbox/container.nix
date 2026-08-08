# NixOS configuration for the devbox container. `inputs` is the host
# flake's inputs; tailnetHostname comes from the host module's options and
# is used only for paseo's Host-header allowlist - the tailnet join itself
# is manual, see the header comment in nixos.nix.
{ inputs, tailnetHostname }:
{ config, pkgs, lib, ... }:
let
  inherit (import ./agents.nix { inherit pkgs lib; }) mkAgent;

  # pi loads npm packages at startup, so it needs node on PATH no matter
  # which project devShell it ends up inside - `direnv exec` largely
  # replaces PATH, so a project whose flake lacks node would silently
  # break pi's plugins. Upstream's home-manager module does this wrapping
  # via extraPackages; we redo it here because we set that module's
  # package to null below.
  piWithNode = pkgs.symlinkJoin {
    name = "pi-with-node";
    paths = [ pkgs.pi-coding-agent ];
    nativeBuildInputs = [ pkgs.makeWrapper ];
    postBuild = ''
      wrapProgram $out/bin/pi --suffix PATH : ${lib.makeBinPath [ pkgs.nodejs ]}
    '';
  };

  agentPkgs = [
    (mkAgent { name = "claude"; real = lib.getExe pkgs.claude-code; })
    (mkAgent { name = "pi"; real = "${piWithNode}/bin/pi"; })
    (mkAgent { name = "opencode"; real = lib.getExe pkgs.opencode; })
  ];

  # `gh` reads GH_TOKEN/GITHUB_TOKEN or its own keyring; the git credential
  # helper below only covers `git`. Wrapped the same way, reading the token
  # at use time so it never lands in the nix store. Installed instead of
  # bare pkgs.gh below so there is only ever one `gh` in this profile - two
  # same-named derivations of equal priority is a hard pkgs.buildEnv
  # collision, the same class that bit pi and opencode above.
  ghWrapped = pkgs.writeShellScriptBin "gh" ''
    export GH_TOKEN=$(cat /run/secrets/devbox-github-token)
    exec ${lib.getExe pkgs.gh} "$@"
  '';
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

  # Pinned deliberately, and NOT to a host uid. These containers run with
  # PRIVATE_USERS=no and the host's nix-daemon socket bind-mounted, so the
  # container's uid IS a host uid to the daemon - and every uid in
  # mine.users with isSuperUser lands in nix's trusted-users, which is
  # root-equivalent (a trusted client can set extra-sandbox-paths and bind
  # the host's ssh/sops/signing keys into a build). 1500 is outside the
  # host's 1000-1003 range, so the daemon treats the agent as untrusted:
  # it can still build, substitute and realise derivations - everything
  # nix-direnv needs - but cannot override trusted settings.
  #
  # Unlike modules/coding-agents/container.nix there is no uid to *match*,
  # because nothing is bind-mounted from a host user's tree; but that is a
  # reason not to match one, not a reason to leave it unpinned.
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
  nix.settings.experimental-features = [ "nix-command" "flakes" ];
  nix.registry.nixpkgs.flake = inputs.nixpkgs;
  nix.nixPath = [ "nixpkgs=flake:nixpkgs" ];

  mine.allowedUnfree = [ "claude-code" ];

  # Also on the system PATH, not only in the user profile: the paseo
  # daemon's inheritUserEnvironment may or may not pick up
  # /etc/profiles/per-user/agent/bin, and a daemon that cannot find
  # `claude` fails in a way that gives no hint why.
  environment.systemPackages = agentPkgs ++ [ ghWrapped ] ++ (with pkgs; [
    curl fd jq ripgrep git direnv
  ]);

  environment.sessionVariables = {
    CLAUDE_CONFIG_DIR = "/home/agent/.claude-state";
    DISABLE_AUTOUPDATER = "1";
  };

  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    users.agent = {
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

      # direnv's allow-list is keyed by absolute .envrc path, and paseo
      # creates a fresh worktree path per task under its dataDir - so a
      # per-repo `direnv allow` can never cover them. Whitelisting both
      # trees is the same tradeoff DESIGN 6.3 already accepted for cloned
      # repos: the agent in this container runs arbitrary repo code by
      # design, and the container is what contains it.
      programs.direnv.config.whitelist.prefix = [
        "/home/agent/projects"
        "/var/lib/paseo/worktrees"
      ];

      home.packages = agentPkgs;
      home.file.".pi/agent/APPEND_SYSTEM.md".source = ../pi-coding-agent/APPEND_SYSTEM.md;

      programs.git = {
        enable = true;
        settings = {
          user = {
            name = "BJSummerfield";
            email = "brianjsummerfield@gmail.com";
          };
          # Reads the token at use time so it never lands in a config file
          # or the nix store. The token bounds which repos are reachable;
          # a GitHub ruleset is what stops a push to a protected branch.
          credential."https://github.com".helper =
            "!f() { echo username=x-access-token; echo password=$(cat /run/secrets/devbox-github-token); }; f";
        };
      };
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
    # rejected on the Host header - presents as "connects, then 400s".
    hostnames = [ tailnetHostname ];
    dataDir = "/var/lib/paseo";
    # environment.sessionVariables below covers login shells
    # (/etc/set-environment) and systemd *user* services, but this is a
    # system service, so agents paseo spawns would otherwise see neither
    # var: an unauthenticated `claude` reading ~/.claude instead of the
    # bind-mounted state dir, with no obvious cause from the phone side.
    # Duplicated rather than derived from sessionVariables so both stay in
    # one file and can't silently drift - they must always agree.
    environment = {
      CLAUDE_CONFIG_DIR = "/home/agent/.claude-state";
      DISABLE_AUTOUPDATER = "1";
      # The browser UI is OFF by default - resolveWebUiConfig in the
      # daemon's config.js falls through to `?? false` unless one of
      # --web-ui, PASEO_WEB_UI_ENABLED, or features.webUi.enabled in
      # config.json is set. Without it the daemon is perfectly healthy but
      # serves nothing at /, so `tailscale serve` proxies to a 404 and the
      # symptom looks like a routing or Host-header problem rather than a
      # disabled feature.
      #
      # The env var is used rather than services.paseo.settings because
      # settings writes config.json from the nix store, and the daemon also
      # persists its own state (pairing, password) into that same file.
      PASEO_WEB_UI_ENABLED = "true";
    };
  };

  # Tailnet membership is not treated as sufficient authentication on its
  # own (see mine.system.devbox.paseoPasswordFile). Upstream's paseo module
  # has no environmentFile-style option to consume this without the value
  # passing through cfg.environment/cfg.settings - both of which the
  # module renders into the nix store, which is world-readable. Overriding
  # the generated unit's EnvironmentFile directly is the only way to hand
  # the daemon a secret that never touches the store.
  systemd.services.paseo.serviceConfig.EnvironmentFile = "/run/secrets/devbox-paseo-password";

  # paseo's resolveAuthConfig (server/dist/server/server/config.js) only
  # installs a password when PASEO_PASSWORD is non-empty; otherwise it
  # silently falls back to persisted config or no auth at all. Meanwhile
  # systemd only *logs a warning* for an EnvironmentFile= line missing an
  # `=` - the unit still comes up "active". So a malformed
  # devbox-paseo-password (wrong key, stray whitespace, empty value - the
  # natural mistake, since the other two devbox secrets are bare-value
  # files, not KEY=value ones) would leave paseo running unauthenticated on
  # the tailnet with no failure anywhere. This turns that into a hard
  # startup failure instead.
  #
  # Runs with the "+" prefix - i.e. as root, not the unit's own
  # User=agent - because paseoPasswordFile is deliberately root-only
  # (mode = "0400", see mine.system.devbox.paseoPasswordFile); ExecStartPre
  # without "+" runs as the unit's configured User=, which could not read
  # it. Uses grep's own exit status only; never echoes the file's contents,
  # matched or not, so the secret can't reach the unit's stderr/journal.
  systemd.services.paseo.serviceConfig.ExecStartPre = [
    ("+" + toString (pkgs.writeShellScript "devbox-paseo-password-check" ''
      if ! ${lib.getExe pkgs.gnugrep} -Eq '^PASEO_PASSWORD=.+' /run/secrets/devbox-paseo-password; then
        echo "devbox-paseo-password: no non-empty PASEO_PASSWORD=<value> line found - refusing to start paseo unauthenticated (value withheld)" >&2
        exit 1
      fi
    ''))
  ];

  ##########################################################################
  # tailscale (firewall only - join and serve are manual, see nixos.nix)
  ##########################################################################

  # Deliberately no authKeyFile and no `tailscale serve` unit. Declarative
  # join has been tried on these containers before and is persistently
  # flaky; the same manual one-time ritual used by vikunja-server and
  # local-llm is what actually works here. It is genuinely one-time:
  # /var/lib/tailscale is bind-mounted to /var/lib/tailscale-devbox on the
  # host, so the node identity survives container rebuilds and only needs
  # redoing if that host directory is wiped. The commands are in the header
  # comment of nixos.nix.
  services.tailscale.enable = true;

  networking = {
    # container has no host resolv.conf; needed for the tailscale
    # control plane and for agents fetching from the network
    nameservers = [ "9.9.9.9" "1.1.1.1" ];
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
    path = with pkgs; [ direnv nix git ];
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
