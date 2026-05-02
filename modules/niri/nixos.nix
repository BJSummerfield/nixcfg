{ config, lib, ... }:
let
  cfg = config.mine.system.niri;
in
{
  options.mine.system.niri = {
    enable = lib.mkEnableOption "Enable niri config";

    hostConfig = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Path to a host-specific niri KDL file. Deployed to
        /etc/niri/host.kdl and pulled in by the user-level config
        via `include optional=true`.
      '';
    };
  };

  config = lib.mkIf cfg.enable (lib.mkMerge [
    {
      environment.sessionVariables.NIXOS_OZONE_WL = "1";
      programs.niri.enable = true;
      home-manager.sharedModules = [{ mine.user.niri.enable = true; }];
    }

    (lib.mkIf (cfg.hostConfig != null) {
      environment.etc."niri/host.kdl".source = cfg.hostConfig;
    })
  ]);
}
