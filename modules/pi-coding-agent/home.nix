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

    # pi-superagents user config; merged over the package's bundled
    # defaults, see the comment in settings.nix.
    home.file.".pi/agent/extensions/subagent/config.json".text =
      builtins.toJSON data.superagents;

    programs.pi-coding-agent = {
      enable = true;
      # bun runs pi's package installs (settings.npmCommand); nodejs stays
      # for anything that shells out to node at runtime
      extraPackages = [
        pkgs.nodejs
        pkgs.bun
      ];
      settings = data.settings;
      models = data.models;
    };
  };
}
