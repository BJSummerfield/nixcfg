# NixOS configuration for the devbox container. `inputs` is the host
# flake's inputs; tailnetHostname and tailscaleTags come from the host
# module's options.
{ inputs, tailnetHostname, tailscaleTags }:
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
    };
  };

  ##########################################################################
  # tailscale (join + serve + firewall)
  ##########################################################################

  services.tailscale = {
    enable = true;
    # Joins on first boot with no interactive `tailscale up`. The tag must
    # exist in the ACL policy and the key must be issued for it, or the
    # join fails silently from the container's point of view.
    authKeyFile = "/run/secrets/devbox-tailscale-authkey";
    # Node name is derived from tailnetHostname rather than repeated, so
    # the name tailscale joins under, the name `serve` publishes, and the
    # name paseo accepts in the Host header cannot drift apart. Two
    # sources of truth here present as "connects, then 400s".
    extraUpFlags = [
      "--hostname=${lib.head (lib.splitString "." tailnetHostname)}"
      "--advertise-tags=${lib.concatStringsSep "," tailscaleTags}"
    ];
  };

  # `tailscale serve` config lives in tailscaled's own state, so this is
  # idempotent across boots. It runs after the node has joined, otherwise
  # serve has no identity to attach the proxy to.
  systemd.services.devbox-tailscale-serve = {
    description = "Publish the paseo daemon on the tailnet";
    after = [ "tailscaled-autoconnect.service" ];
    wants = [ "tailscaled-autoconnect.service" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      # `serve` config is idempotent (it lives in tailscaled's own state),
      # so retrying costs nothing. Without this, one transient failure -
      # tailscaled not fully ready, tag join rejected, HTTPS certs not
      # enabled in the tailnet console - leaves devbox unreachable for the
      # whole boot, and the only client is a phone with no way to retry it
      # locally.
      Restart = "on-failure";
      RestartSec = 30;
    };
    script = ''
      ${lib.getExe pkgs.tailscale} serve --bg 6767
    '';
  };

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
      for repo in /home/agent/projects/*/ /var/lib/paseo/worktrees/*/; do
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
  systemd.paths.devbox-warm = {
    description = "Watch devbox projects and worktrees for new or changed flakes";
    wantedBy = [ "multi-user.target" ];
    pathConfig.PathChanged = [
      "/home/agent/projects"
      "/var/lib/paseo/worktrees"
    ];
  };

  # Backstop: catches flake.lock edits made inside an existing repo, which
  # the path unit's directory watch does not see.
  systemd.timers.devbox-warm = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = "daily";
      Persistent = true;
    };
  };

  system.stateVersion = "26.05";
}
