{
  pkgs,
  config,
  lib,
  ...
}:
let
  inherit (lib)
    mkEnableOption
    mkIf
    mkMerge
    ;
  cfg = config.mine.user.hyprlax;
  niriCfg = config.mine.user.niri;
in
{
  options.mine.user.hyprlax = {
    enable = mkEnableOption "Enable hyprlax config";
  };
  config = mkIf cfg.enable (mkMerge [
    {
      home.file.".config/hyprlax".source = ./scenes/pixel-city;
      systemd.user.services.hyprlax = {
        Unit = {
          Description = "Hyprlax Parallax Wallpaper Service";
          PartOf = [ "graphical-session.target" ];
          After = [ "graphical-session.target" ];
        };
        Service = {
          Type = "simple";
          ExecStart = ''
            ${pkgs.hyprlax}/bin/hyprlax --config "${config.home.homeDirectory}/.config/hyprlax/parallax.toml"
          '';
          Restart = "on-failure";
          RestartSec = "1s";
        };
        Install = {
          WantedBy = [ "graphical-session.target" ];
        };
      };
      home.packages = with pkgs; [
        hyprlax
      ];
    }
    (mkIf niriCfg.enable {
      mine.user.niri.extraConfig = ''
        layer-rule {
            match namespace="^hyprlax$"
            place-within-backdrop true
        }
      '';
    })
  ]);
}
