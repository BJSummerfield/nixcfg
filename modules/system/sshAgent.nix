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
      programs.ssh = mkIf _1passwordAgent {
        enable = true;
        enableDefaultConfig = false;
        matchBlocks."*" = {
          forwardAgent = false;
          addKeysToAgent = "no";
          compression = false;
          serverAliveInterval = 0;
          serverAliveCountMax = 3;
          hashKnownHosts = false;
          userKnownHostsFile = "~/.ssh/known_hosts";
          controlMaster = "no";
          controlPath = "~/.ssh/master-%r@%n:%p";
          controlPersist = "no";
        };
        extraConfig = ''
          Host *
              IdentityAgent ~/.1password/agent.sock              
        '';
      };
    };
  };
}
