{ config, lib, pkgs, inputs, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.system.pi-dev;

  # Host-side launcher. No project directories are mounted statically:
  # each invocation bind-mounts the caller's cwd into the running container
  # (machinectl bind), so the agent only ever sees projects explicitly
  # opened with `pi-dev`. Stopping the container (`pi-dev stop`) drops all
  # of those mounts again.
  launcher = pkgs.writeShellScriptBin "pi-dev" ''
    set -euo pipefail

    if [ "''${1:-}" = "stop" ]; then
      exec sudo systemctl stop container@pi-dev
    fi

    if ! systemctl is-active --quiet container@pi-dev; then
      echo "Starting pi-dev container..." >&2
      sudo systemctl start container@pi-dev
      # wait for the machine to register with machined
      for _ in $(seq 1 25); do
        machinectl status pi-dev >/dev/null 2>&1 && break
        sleep 0.2
      done
    fi

    dest="/home/agent/projects/$(basename "''${PWD}")"
    # Fails harmlessly if this project is already bound from a previous run.
    sudo machinectl bind --mkdir pi-dev "''${PWD}" "''${dest}" 2>/dev/null || true
    exec sudo machinectl shell agent@pi-dev /bin/sh -lc "cd \"''${dest}\" && exec pi"
  '';
in
{
  options.mine.system.pi-dev = {
    enable = mkEnableOption "pi-dev, an isolated nspawn container for running the pi coding agent without pi-sandbox";
  };

  config = mkIf cfg.enable {
    environment.systemPackages = [ launcher ];

    containers.pi-dev = {
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
        # the daemon as a trusted-user. Same exposure the host pi-sandbox
        # config already accepted via allowAllUnixSockets.
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
            imports = [ ../pi-coding-agent/home.nix ];
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
              # Environment: pi-dev container

              You are running inside `pi-dev`, an isolated NixOS container
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
