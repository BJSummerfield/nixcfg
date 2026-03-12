{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.system.pipewire.sample-switch;
in
{
  options.mine.system.pipewire.sample-switch.enable = mkEnableOption "pipewire system config";
  config = mkIf cfg.enable {
    services.pipewire.extraConfig.pipewire."92-sample-rate" = {
      "context.properties" = {
        "default.clock.rate" = 48000;
        "default.clock.allowed-rates" = [ 44100 48000 88200 96000 176400 192000 ];
      };
    };
  };
}
