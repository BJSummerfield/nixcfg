{ lib, config, ... }: {
  imports = [
    ./_1password
    ./alacritty
    ./avahi
    ./battery-notifications
    ./bicep-langserver
    ./catppuccin
    ./direnv
    ./docker
    ./encode_queue
    ./firefox
    ./fish
    ./fuzzel
    ./gamescope
    ./gh
    ./git
    ./helix
    ./keybase
    ./lazygit
    ./makemkv
    ./mako
    ./mpls
    ./niri
    ./obs-studio
    ./openssh
    ./polkit_gnome
    ./printing
    ./steam
    ./stylix
    ./swaybg
    ./swayidle
    ./swaylock
    ./system
    ./tailscale
    ./users
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
