{ pkgs, lib, config, ... }:
{
  options.mine.system.git.enable = lib.mkEnableOption "Enable System Git";

  config = lib.mkMerge [
    {
      environment.systemPackages = lib.mkIf config.mine.system.git.enable [ pkgs.git ];
    }
    {
      home-manager.sharedModules = [ ./git.nix ];
    }
  ];
}
