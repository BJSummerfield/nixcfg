{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.cli-tools.helix.lsp.python;
in
{
  options.mine.cli-tools.helix.lsp.python.enable = mkEnableOption "Enable python lsp for helix";
  config = mkIf cfg.enable {

    home-manager.users.${user.name} = {
      programs.helix = {
        languages = {
          language = [{
            name = "python";
            auto-format = true;
          }];
        };
        extraPackages = with pkgs; [
          ruff
        ];
      };
    };
  };
}
