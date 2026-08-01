# NixOS configuration shared by every instance in the pi container pool.
# Imported per-instance by nixos.nix; `inputs` is the host flake's inputs.
{ inputs }:
{ pkgs, ... }:
{
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

      home.file.".pi/agent/APPEND_SYSTEM.md".source = ./APPEND_SYSTEM.md;
    };
  };

  system.stateVersion = "26.05";
}
