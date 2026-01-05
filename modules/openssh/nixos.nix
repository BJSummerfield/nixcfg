{ lib, config, ... }:
{
  options.mine.system.openssh = {
    enable = lib.mkEnableOption "Enable open SSH";
  };

  config = lib.mkIf config.mine.system.openssh.enable {
    services.openssh = {
      enable = true;
      settings = {
        PermitRootLogin = "no";
        PasswordAuthentication = false;
      };
    };

    # ssh is disabled on boot, use systemctl to turn it on when needed with 'start'
    systemd.services.sshd.wantedBy = lib.mkForce [ ];
  };
}
