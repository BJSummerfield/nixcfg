{
  lib,
  config,
  pkgs,
  ...
}:
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
    # pi-web-access provider config (keyless); seeded declaratively so a
    # freshly built container comes up with search already configured
    # instead of needing a manual first-run setup.
    home.file.".pi/agent/web-search.json".text = builtins.toJSON data.webSearch;

    programs.pi-coding-agent = {
      enable = true;
      # shared with modules/devbox/container.nix, which wraps pi by hand -
      # see the header of extra-packages.nix
      extraPackages = import ./extra-packages.nix pkgs;
      settings = data.settings;
      models = data.models;
    };
  };
}
