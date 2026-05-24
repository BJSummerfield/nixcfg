{ config, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.mako;
in
{
  options.mine.user.mako.enable = mkEnableOption "Enable Mako config";
  config = mkIf cfg.enable {
    services.mako = {
      enable = true;
      settings = {
        background-color = "#1e1e2ecc";
        text-color = "#cdd6f4";
        border-color = "#89b4fa";
        progress-color = "over #313244";
        font = "MonaspiceNe Nerd Font 13";
        anchor = "top-right";
        layer = "overlay";
        margin = "10";
        padding = "10";
        width = 400;
        max-visible = 5;
        border-size = 1;

        default-timeout = 12000;
        sort = "-time";
        history = true;

        "urgency=critical" = {
          background-color = "#1e1e2ecc";
          text-color = "#cdd6f4";
          border-color = "#f38ba8";
          default-timeout = 0;
        };
        "urgency=low" = {
          background-color = "#1e1e2ecc";
          text-color = "#cdd6f4";
          border-color = "#6c7086";
        };
      };
    };
  };
}
