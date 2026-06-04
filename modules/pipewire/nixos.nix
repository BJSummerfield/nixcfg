{ lib, pkgs, config, ... }:
let
  inherit (lib) mkEnableOption mkIf mkMerge;
  cfg = config.mine.system.pipewire;
in
{
  options.mine.system.pipewire = {
    enable =
      mkEnableOption "PipeWire audio stack (PipeWire + WirePlumber + ALSA/Pulse compat)";
    sample-switch.enable = mkEnableOption "pipewire sample-rate config";
  };

  config = mkMerge [
    (mkIf cfg.enable {
      services.pipewire = {
        enable = true;
        alsa.enable = true;
        alsa.support32Bit = true;
        pulse.enable = true;
      };
      security.rtkit.enable = true;

      environment.systemPackages = [ pkgs.wireplumber ];
    })

    (mkIf cfg.sample-switch.enable {
      services.pipewire.extraConfig.pipewire."92-sample-rate" = {
        "context.properties" = {
          "default.clock.rate" = 48000;
          "default.clock.allowed-rates" = [ 44100 48000 88200 96000 176400 192000 ];
        };
      };
    })
  ];
}
