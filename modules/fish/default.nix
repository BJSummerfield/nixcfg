{ pkgs, lib, config, ... }:
let
  cfg = config.mine.system.shell.fish;
in
{
  home-manager.sharedModules = [ ./home.nix ];
  options.mine.system.shell.fish.enable = lib.mkEnableOption "System Fish";

  config = lib.mkIf cfg.enable {
    programs.fish.enable = true;
    users.defaultUserShell = pkgs.fish;
  };
}
