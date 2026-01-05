{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.helix.lsp.python;
in
{
  options.mine.user.helix.lsp.python.enable = mkEnableOption "Enable python lsp for helix";
  config = mkIf cfg.enable {

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
}
