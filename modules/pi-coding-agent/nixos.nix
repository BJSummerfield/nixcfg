{ config, lib, pkgs, inputs, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.system.pi-coding-agent;

  # Host-side `pi`: runs the agent inside the container. No project
  # directories are mounted statically - each invocation bind-mounts the
  # caller's cwd into the running container (machinectl bind), so the agent
  # only ever sees projects explicitly opened with `pi`. `pi stop` drops
  # the mounts; `pi reset` additionally wipes all container state.
  launcher = pkgs.writeShellScriptBin "pi" ''
    set -euo pipefail

    case "''${1:-}" in
      stop)
        exec sudo systemctl stop container@pi
        ;;
      reset)
        sudo systemctl stop container@pi 2>/dev/null || true
        sudo rm -rf /var/lib/nixos-containers/pi
        echo "pi container state wiped; next run starts fresh" >&2
        exit 0
        ;;
    esac

    if ! systemctl is-active --quiet container@pi; then
      echo "Starting pi container..." >&2
      sudo systemctl start container@pi
      # wait for the machine to register with machined
      for _ in $(seq 1 25); do
        machinectl status pi >/dev/null 2>&1 && break
        sleep 0.2
      done
    fi

    dest="/home/agent/projects/$(basename "''${PWD}")"
    # Fails harmlessly if this project is already bound from a previous run.
    sudo machinectl bind --mkdir pi "''${PWD}" "''${dest}" 2>/dev/null || true

    args=""
    if [ "$#" -gt 0 ]; then
      args=$(printf '%q ' "$@")
    fi
    exec sudo machinectl shell agent@pi /bin/sh -lc "cd \"''${dest}\" && exec pi ''${args}"
  '';
in
{
  options.mine.system.pi-coding-agent = {
    enable = mkEnableOption "pi coding agent, running inside an isolated nspawn container";
  };

  config = mkIf cfg.enable {
    environment.systemPackages = [ launcher ];

    containers.pi = {
      autoStart = false;
      # Shares the host network namespace: DNS, the tailnet (model endpoint)
      # and localhost all work with zero plumbing. The isolation this
      # container provides is filesystem/process, not network - the agent
      # is allowed full egress by design.
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
              # Environment: pi container

              You are running inside an isolated NixOS container
              (systemd-nspawn). The container is the security boundary - there
              is no sandbox wrapping your commands, so tools behave normally.

              - The project you were opened in is bind-mounted under
                ~/projects/<name>. These are the user's real files; edits are
                immediately visible on the host. Everything else in this
                filesystem is disposable container state.
              - Host secrets (SSH keys, GPG, password stores, browser
                profiles) do not exist here. If git push or any authenticated
                operation fails, report it and let the user run it from the
                host - do not hunt for credentials.
              - You have unrestricted network access.
              - Missing tools: install them yourself. Prefer
                `nix shell nixpkgs#<pkg>` or `nix-shell -p <pkg>` (pinned,
                shared store, no download for anything the host already has);
                npm/pip/cargo also work. There is no sudo and you will never
                need it.
            '';
          };
        };

        system.stateVersion = "26.05";
      };
    };
  };
}
