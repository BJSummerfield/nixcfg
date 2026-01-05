{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.system.makemkv;
in
{
  options.mine.system.makemkv.enable = mkEnableOption "Enable makemkv";

  config = mkIf cfg.enable {

    mine.allowedUnfree = [
      "makemkv"
    ];
    boot.kernelModules = [ "sg" ];
    environment.systemPackages = [ pkgs.makemkv ];
  };
}
