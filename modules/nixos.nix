{ lib, config, ... }: {
  imports = [
    ./_1password/nixos.nix
    ./avahi/nixos.nix
    ./docker/nixos.nix
    ./fish/nixos.nix
    ./gamescope/nixos.nix
    ./makemkv/nixos.nix
    ./niri/nixos.nix
    ./openssh/nixos.nix
    ./printing/nixos.nix
    ./steam/nixos.nix
    ./tailscale/nixos.nix
    ./users/nixos.nix
  ];

  # This takes all our unfree packages and adds them to the predicate for system and home-manager
  options.mine.system = {
    allowedUnfree = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "List of unfree packages to allow.";
    };
  };
  config = {
    nixpkgs.config.allowUnfreePredicate = pkg:
      builtins.elem (lib.getName pkg) config.mine.system.allowedUnfree;
    home-manager.sharedModules = [
      ({ lib, ... }: {
        nixpkgs.config.allowUnfreePredicate = pkg:
          builtins.elem (lib.getName pkg) config.mine.system.allowedUnfree;
      })
    ];
  };
}
