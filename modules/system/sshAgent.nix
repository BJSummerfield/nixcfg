{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  _1passwordAgent = config.mine.apps._1password.sshAgent;
in
{
  options.mine.system.ssh = {
    enable = mkEnableOption "Enable ssh config";
  };

  config = {
    home-manager.users.${user.name} = {
      #Only for 1pass for now
      programs.ssh = mkIf _1passwordAgent {
        # enableDefaultConfig = true;
        # matchBlocks = "*";
        extraConfig = ''
          Host *
              IdentityAgent ~/.1password/agent.sock              
        '';
      };
    };
  };
}
