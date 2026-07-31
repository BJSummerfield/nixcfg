{ config, lib, pkgs, inputs, ... }:
let
  inherit (lib) genAttrs mkEnableOption mkIf mkOption range types;
  cfg = config.mine.system.pi-coding-agent;

  instanceNames = map (i: "pi-${toString i}") (range 1 cfg.instances);

  # Host-side `pi`: each invocation grabs an idle instance from the pool,
  # bind-mounts only the caller's cwd into it, runs the agent, and stops
  # the instance (discarding its root) when the session ends. Agents are
  # thereby isolated from each other's projects.
  launcher = pkgs.writeShellScriptBin "pi" ''
    set -euo pipefail

    instances="${toString instanceNames}"

    case "''${1:-}" in
      stop)
        for c in $instances; do
          sudo systemctl stop "container@$c" 2>/dev/null || true
        done
        exit 0
        ;;
    esac

    # Serialize slot selection so concurrent launches can't grab the same
    # idle instance.
    exec 9>/tmp/.pi-launcher.lock
    flock 9
    slot=""
    for c in $instances; do
      if ! systemctl is-active --quiet "container@$c"; then
        slot="$c"
        break
      fi
    done
    if [ -z "$slot" ]; then
      echo "all ${toString cfg.instances} pi instances are busy; close one or raise mine.system.pi-coding-agent.instances" >&2
      exit 1
    fi
    sudo systemctl start "container@$slot"
    flock -u 9

    # Wait for the instance to register with machined and finish booting.
    for _ in $(seq 1 100); do
      state=$(sudo systemctl -M "$slot" is-system-running 2>/dev/null || true)
      case "$state" in running | degraded) break ;; esac
      sleep 0.2
    done

    # Mirror the host path relative to $HOME so two projects with the same
    # basename can never collide on a mount point.
    rel="''${PWD#"''${HOME}"/}"
    if [ "''${rel}" = "''${PWD}" ]; then
      rel="external/$(basename "''${PWD}")"
    fi
    dest="/home/agent/''${rel}"
    sudo machinectl bind --mkdir "$slot" "''${PWD}" "''${dest}"

    args=""
    if [ "$#" -gt 0 ]; then
      args=$(printf '%q ' "$@")
    fi
    trap 'sudo systemctl stop "container@$slot" 2>/dev/null || true' EXIT
    sudo machinectl shell "agent@$slot" /bin/sh -lc "cd \"''${dest}\" && exec pi ''${args}"
  '';
in
{
  options.mine.system.pi-coding-agent = {
    enable = mkEnableOption "pi coding agent, each session in its own ephemeral nspawn container";
    instances = mkOption {
      type = types.ints.positive;
      default = 4;
      description = "Maximum number of concurrently running agent sessions (size of the container pool).";
    };
  };

  config = mkIf cfg.enable {
    environment.systemPackages = [ launcher ];

    containers = genAttrs instanceNames (name: {
      autoStart = false;
      # Empty root bootstrapped on every start, discarded on stop. Nothing
      # persists between sessions except the project mount, which is the
      # user's real directory anyway. Config and extensions come from the
      # store via home-manager; pi installs its npm packages at startup.
      ephemeral = true;
      # Shares the host network namespace: DNS, the tailnet (model
      # endpoint) and localhost all work with zero plumbing. The isolation
      # this container provides is filesystem/process, not network - the
      # agent is allowed full egress by design.
      privateNetwork = false;

      config = { pkgs, ... }: {
        imports = [ inputs.home-manager.nixosModules.home-manager ];

        # Same uid as the host user so bind-mounted project files stay
        # writable. nixos containers bind the host nix-daemon socket by
        # default, so the daemon sees this uid - i.e. the agent talks to
        # the daemon as a trusted-user. Same exposure the old pi-sandbox
        # config accepted via allowAllUnixSockets.
        users.users.agent = {
          isNormalUser = true;
          uid = 1000;
          description = "pi coding agent";
        };

        # nix builds go through the host daemon; the store is shared
        # read-only. Pin the registry so `nix shell nixpkgs#foo` resolves
        # to the host's nixpkgs instantly instead of fetching unstable.
        nix.settings.experimental-features = [ "nix-command" "flakes" ];
        nix.registry.nixpkgs.flake = inputs.nixpkgs;
        nix.nixPath = [ "nixpkgs=flake:nixpkgs" ];

        environment.systemPackages = with pkgs; [
          curl
          fd
          jq
          ripgrep
        ];

        home-manager = {
          useGlobalPkgs = true;
          useUserPackages = true;
          users.agent = {
            imports = [ ./home.nix ];
            home.stateVersion = "26.05";

            # No pi-sandbox in here: the container is the boundary.
            mine.user.pi-coding-agent.enable = true;

            # Unsigned commits: the signing key stays on the host.
            programs.git = {
              enable = true;
              settings.user = {
                name = "BJSummerfield";
                email = "brianjsummerfield@gmail.com";
              };
            };

            home.file.".pi/agent/APPEND_SYSTEM.md".text = ''
              # Environment: ephemeral pi container

              You are running inside an ephemeral NixOS container
              (systemd-nspawn) created for this session. The container is
              the security boundary - there is no sandbox wrapping your
              commands, so tools behave normally.

              - The project you were opened in is bind-mounted at the same
                home-relative path as on the host (e.g. ~/projects/<name>).
                These are the user's real files; edits are immediately
                visible on the host and survive the session.
              - Nothing else survives: this entire filesystem, including
                your home directory, is discarded when the session ends.
                Anything worth keeping must be written into the project.
              - Host secrets (SSH keys, GPG, password stores, browser
                profiles) do not exist here. If git push or any
                authenticated operation fails, report it and let the user
                run it from the host - do not hunt for credentials.
              - You have unrestricted network access.
              - Missing tools: install them yourself. Prefer
                `nix shell nixpkgs#<pkg>` or `nix-shell -p <pkg>` (pinned,
                shared store, no download for anything the host already
                has); npm/pip/cargo also work. There is no sudo and you
                will never need it.
            '';
          };
        };

        system.stateVersion = "26.05";
      };
    });
  };
}
