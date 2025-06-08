{ config, lib, ... }:
with lib; let
  cfg = config.features.desktop.fuzzel;
in
{
  options.features.desktop.fuzzel = {
    enable = mkEnableOption "Enable fuzzel config";
    uwsm = mkOption {
      type = types.bool;
      default = false;
      description = "Enable UWSM integration for fuzzel, setting launch-prefix.";
    };
  };

  config = mkIf cfg.enable {
    programs.fuzzel = {
      enable = true;
      settings = mkMerge [
        # Base settings that should always apply
        {
          border.radius = 0;
        }
        # Conditional settings that only apply if cfg.uwsm is true
        (mkIf cfg.uwsm {
          main = {
            launch-prefix = "uwsm app -- ";
          };
        })
      ];
    };
  };
}
