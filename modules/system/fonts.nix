{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkOption mkIf types;
  inherit (config.mine) user;
  cfg = config.mine.system.fonts;
in
{
  options.mine.system.fonts = {
    enable = mkEnableOption "Fonts enable";
    name = mkOption {
      type = types.str;
      default = "";
      description = "Font name";
    };
  };

  config = mkIf cfg.enable {
    mine.system.fonts.name = "MonaspiceNe Nerd Font";
    home-manager.users.${user.name} = {
      fonts.fontconfig.enable = true;
      home.packages = with pkgs; [
        nerd-fonts.monaspace
      ];
    };
  };
}
