{ pkgs, lib, config, ... }:
{
  options.mine.system.lazygit.enable = lib.mkEnableOption "System Lazygit";

  config = lib.mkMerge [
    {
      environment.systemPackages = lib.mkIf config.mine.system.lazygit.enable [ pkgs.lazygit ];
      home-manager.sharedModules = [ ./lazygit.nix ];
    }
  ];
}
