{ lib, config, ... }:
let
  inherit (lib) mkIf;
  inherit (config.mine) user;
  _1passAgent = config.mine.apps._1password.sshAgent;
in
{

  config = mkIf _1passAgent.enable {
    home-manager.users.${user.name} = {
      programs.ssh = {
        enable = true;
        extraConfig = ''
          Host *
              IdentityAgent ~/.1password/agent.sock              
        '';
      };
    };
  };
}
