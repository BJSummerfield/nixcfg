{ lib
, config
, pkgs
, inputs
, ...
}:
let

  inherit (lib)
    mkEnableOption
    mkOption
    mkIf
    types
    ;
  inherit (config.mine) user;

  cfg = config.mine.user;
in
{
  options.mine.user = {
    enable = mkEnableOption "Enable User";
    name = mkOption {
      type = types.str;
      default = "waktu";
      description = "User account name";
    };
    email = mkOption {
      type = types.str;
      default = "brianjsummerfield@gmail.com";
      description = "My Email";
    };
    homeDir = mkOption {
      type = types.str;
      default = "/home/${config.mine.user.name}";
      description = "Home Directory Path";
    };
    home-manager.enable = mkOption {
      type = types.bool;
      default = false;
      description = "Enable home-manager";
    };
    shell = mkOption {
      default = { };
      description = "Shell config for user";
      type = types.submodule {
        options = {
          package = mkOption {
            type = types.package;
            default = pkgs.fish;
            description = "User shell";
          };
        };
      };
    };
  };

  config = mkIf cfg.enable {
    mine.system.shell.fish.enable = mkIf (cfg.shell.package == pkgs.fish) true;
    nix.settings.trusted-users = [ "${cfg.name}" ];

    users.groups.${cfg.name} = { };

    users.users.${cfg.name} = {
      initialHashedPassword = "$y$j9T$IoChbWGYRh.rKfmm0G86X0$bYgsWqDRkvX.EBzJTX.Z0RsTlwspADpvEF3QErNyCMC";
      isNormalUser = true;
      openssh.authorizedKeys.keys = [
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILtTarFZkhNoHtu39C6eCRaS84jb6SPoY92gn64Q2D3O"
      ];
      group = "${cfg.name}";
      extraGroups = [
        "wheel"
        "networkmanager"
      ];
      shell = cfg.shell.package;
    };

  };
}
