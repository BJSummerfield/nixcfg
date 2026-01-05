{ lib, config, ... }: {
  imports = [
    ./docker
    ./direnv
    ./encode_queue
    ./eza
    ./bicep-langserver
    ./_1password
    ./polkit_gnome
    ./keybase
    ./obs-studio
    ./printing
    ./avahi
    ./steam
    ./gamescope
    ./printing
    ./alacritty
    ./fuzzel
    ./niri
    # ./apps
    # ./user
    ./system
    # ./encoding
    # ./cli-tools
    # ./desktop
    ./fish
    ./firefox
    ./lazygit
    ./git
    ./tailscale
    ./openssh
    ./xwayland-satellite
  ];

  # This takes all our unfree packages and adds them to the predicate
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
  };
}
