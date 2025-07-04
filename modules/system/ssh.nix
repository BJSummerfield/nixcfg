{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkOption mkIf types;
  inherit (config.mine) user;
  cfg = config.mine.system.ssh;
in
{
  # TODO import the key as an array
  options.mine.system.ssh = {
    enable = mkEnableOption "enable SSH";
    authorizedKeys = mkOption {
      type = types.str;
      description = "Authorized ssh key";
    };
  };

  config = mkIf cfg.enable {
    services.openssh = {
      enable = true;
      settings = {
        PermitRootLogin = "no";
        PasswordAuthentication = false;
      };
    };

    # ssh is disabled on boot, use systemctl to turn it on when needed with 'start'
    systemd.services.sshd.wantedBy = lib.mkForce [ ];

    users.users.${user.name} = {
      openssh.authorizedKeys.keys = [
        cfg.authorizedKeys
      ];
    };
  };
}
