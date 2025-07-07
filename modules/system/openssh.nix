{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.system.openssh;
in
{
  options.mine.system.openssh = {
    enable = mkEnableOption "enable SSH";
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
  };
}
