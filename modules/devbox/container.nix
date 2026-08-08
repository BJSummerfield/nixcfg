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
in
{
  imports = [
    inputs.home-manager.nixosModules.home-manager
    inputs.paseo.nixosModules.paseo
    ../unfree/nixos.nix
  ];

  # No pinned uid, deliberately: unlike modules/coding-agents/container.nix,
  # nothing here is bind-mounted from the host user's tree, so there is no
  # uid to match. Repos live in the container's own filesystem.
  users.users.agent = {
    isNormalUser = true;
    home = "/home/agent";
    description = "coding agent";
  };

  mine.allowedUnfree = [ "claude-code" ];

  # Also on the system PATH, not only in the user profile: the paseo
  # daemon's inheritUserEnvironment may or may not pick up
  # /etc/profiles/per-user/agent/bin, and a daemon that cannot find
  # `claude` fails in a way that gives no hint why.
  environment.systemPackages = agentPkgs ++ (with pkgs; [
    curl fd jq ripgrep gh git direnv
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

      home.packages = agentPkgs;
      home.file.".pi/agent/APPEND_SYSTEM.md".source = ../pi-coding-agent/APPEND_SYSTEM.md;

      # Suppresses the upstream modules' own bin/pi and bin/opencode -
      # otherwise they collide with the mkAgent wrappers of the same name
      # in this same home-manager profile (pkgs.buildEnv fails hard on
      # same-name paths of equal priority). Settings/config generation
      # from these modules is untouched; only the package is disabled.
      programs.pi-coding-agent.package = null;
      programs.opencode.package = null;

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
  };

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

  # Builds every repo's devShell ahead of first use, so an agent launched
  # from a phone never blocks on a cold `nix develop`. nix-direnv creates
  # GC roots, so a warmed shell survives nix-collect-garbage.
  systemd.services.devbox-warm = {
    description = "Warm direnv devShells for all devbox projects";
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
      for repo in /home/agent/projects/*/; do
        [ -f "$repo/.envrc" ] || continue
        cd "$repo" || continue
        echo "warming $repo"
        direnv allow . || { echo "could not allow $repo/.envrc" >&2; continue; }
        direnv exec . true || echo "devShell build failed for $repo" >&2
      done
    '';
  };

  # Fires when a repo appears or its flake changes.
  systemd.paths.devbox-warm = {
    description = "Watch devbox projects for new or changed flakes";
    wantedBy = [ "multi-user.target" ];
    pathConfig.PathChanged = "/home/agent/projects";
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

  systemd.tmpfiles.rules = [
    "d /home/agent/projects 0755 agent users -"
  ];

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

  system.stateVersion = "26.05";
}
