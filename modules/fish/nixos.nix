{ pkgs, lib, config, ... }:
let
  cfg = config.mine.system.fish;
in
{
  options.mine.system.fish.enable = lib.mkEnableOption "System Fish";

  config = lib.mkIf cfg.enable {
    programs.fish.enable = true;
    users.defaultUserShell = pkgs.fish;
  };
}
