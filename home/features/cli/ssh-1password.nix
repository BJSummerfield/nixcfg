{ inputs
, pkgs
, config
, lib
, ...
}:
with lib; let
  cfg = config.features.cli.ssh-1password;
in
{
  options.features.cli.ssh-1password.enable = mkEnableOption "enable extended _1password-ssh configuration";

  imports = [ inputs._1password-shell-plugins.hmModules.default ];
  config = mkIf cfg.enable {


    programs._1password-shell-plugins = {
      # enable 1Password shell plugins for bash, zsh, and fish shell
      enable = true;
      # the specified packages as well as 1Password CLI will be
      # automatically installed and configured to use shell plugins
      plugins = with pkgs; [ gh ];
    };

    programs.ssh = {
      enable = true;
      extraConfig = ''
        Host *
            IdentityAgent ~/.1password/agent.sock              
      '';
    };
  };
}
