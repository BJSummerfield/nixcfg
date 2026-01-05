{ lib, config, ... }: {
  imports = [
    ./docker
    ./mako
    ./direnv
    ./catppuccin
    ./stylix
    ./swaybg
    ./swayidle
    ./swaylock
    ./encode_queue
    ./bicep-langserver
    ./_1password
    ./polkit_gnome
    ./keybase
    ./obs-studio
    ./printing
    ./avahi
    ./steam
    ./gamescope
    ./alacritty
    ./gh
    ./mpls
    ./makemkv
    ./helix
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
    ./battery-notifications
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
