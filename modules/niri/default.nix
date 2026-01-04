{ config, lib, ... }:
let
  cfg = config.mine.system.niri;
in
{
  options.mine.system.niri = {
    enable = lib.mkEnableOption "Enable niri config";

    outputs = lib.mkOption {
      description = "Attrset of outputs, where key is the output name (e.g. DP-1)";
      default = { };
      type = lib.types.attrsOf (lib.types.submodule {
        options = {
          mode = lib.mkOption {
            type = lib.types.str;
            description = "Resolution and refresh rate (e.g. 3440x1440@175)";
          };
          variableRefreshRate = lib.mkOption {
            type = lib.types.bool;
            default = false;
          };
          scale = lib.mkOption {
            type = lib.types.float;
            default = 1.0;
          };
        };
      });
    };

    extraWindowRules = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "List of KDL window-rule blocks to append to config";
    };
  };
  config = lib.mkIf cfg.enable {
    programs.niri.enable = true;
    mine.user.xwayland-satellite.enable = true;
    # mine.apps._1password.silentStartOnGraphical = true;
    home-manager.sharedModules = [ ./home.nix ];
  };
}
