{ pkgs, config, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf optionals;
  inherit (config.mine) user;
  cfg = config.mine.apps."jellyfin-media-player";
in
{
  options.mine.apps."jellyfin-media-player" = {
    enable = mkEnableOption "Enable Jellyfin Media Player";
    overlay = mkEnableOption "Use Qt6 overlay build (Recommended)";
  };

  config = mkIf cfg.enable {
    home-manager.users.${user.name} = {
      home.packages = [ pkgs.jellyfin-media-player ];
    };

    nixpkgs.config.permittedInsecurePackages = optionals (!cfg.overlay) [
      "qtwebengine-5.15.19"
    ];

    nixpkgs.overlays = mkIf cfg.overlay [
      (self: super: {
        jellyfin-media-player =
          super.callPackage ../pkgs/jellyfin-media-player.package.nix { };
      })
    ];
  };
}
