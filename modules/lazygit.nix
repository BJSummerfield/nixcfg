{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  homeConfig = { config, ... }: {
    options.mine.user.lazygit.enable = mkEnableOption "User Lazygit";

    config = mkIf config.mine.user.lazygit.enable {
      programs.lazygit = {
        enable = true;
        settings.gui.language = "en";
      };
      programs.fish.shellAliases.lg = "lazygit";
    };
  };
in
{
  options.mine.system.lazygit.enable = mkEnableOption "System Lazygit";

  config = {
    environment.systemPackages = mkIf config.mine.system.lazygit.enable [ pkgs.lazygit ];
    home-manager.sharedModules = [ homeConfig ];
  };
}
