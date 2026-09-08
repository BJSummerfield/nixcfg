{ lib, config, ... }:
let
  inherit (lib) mkIf;
  cfg = config.mine.user.alacritty;
  niriCfg = config.mine.user.niri;
in
{
  config = mkIf (cfg.enable && niriCfg.enable) {
    mine.user.niri.extraBinds = ''
      Mod+Return { spawn "${lib.getExe config.programs.alacritty.package}"; }
    '';
  };
}
