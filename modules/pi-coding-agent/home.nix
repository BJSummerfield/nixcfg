{ lib, config, pkgs, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.pi-coding-agent;
  data = import ./settings.nix;
in
{
  options.mine.user.pi-coding-agent = {
    enable = mkEnableOption "pi AI coding agent";
  };
  config = mkIf cfg.enable {
    # pi-web-access provider config (keyless); seeded declaratively so
    # ephemeral containers start with search already configured.
    home.file.".pi/agent/web-search.json".text = builtins.toJSON data.webSearch;

    programs.pi-coding-agent = {
      enable = true;
      # npm is needed so pi can install npm packages like pi-web-access
      extraPackages = [
        pkgs.nodejs
      ];
      settings = data.settings;
      models = data.models;
    };
  };
}
