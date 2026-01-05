{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.eza;
in
{
  options.mine.user.eza.enable = mkEnableOption "Eza config";
  config = mkIf cfg.enable {
    programs.eza.enable = true;
  };
}
