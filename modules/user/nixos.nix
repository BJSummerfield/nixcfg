{ lib, config, pkgs, inputs, ... }:
let
  inherit (lib) mkOption mkIf types;
  inherit (config.mine) user;

in
{

  imports = [
    inputs.home-manager.nixosModules.home-manager
  ];

  options.mine.user = {
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
    git-user = mkOption {
      type = types.str;
      default = "BJSummerfield";
      description = "Git username";
    };
    homeDir = mkOption {
      type = types.str;
      default = "/home/${user.name}";
      description = "Home Directory Path";
    };
    sshKey = mkOption {
      type = types.str;
      default = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILtTarFZkhNoHtu39C6eCRaS84jb6SPoY92gn64Q2D3O";
      description = "Authorized SSH Key";
    };
    gitSigningKey = mkOption {
      type = types.str;
      default = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP2G3biYuL3iFvhAXYNuVzvRpAQMmFFLek3KFZV4PfDu";
      description = "Git Signing Key";
    };
    wallpaper = mkOption {
      type = types.str;
      default = "mountain.jpg";
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

  config = {
    # This belongs in makemkv
    boot.kernelModules = [ "sg" ];
    mine.system.shell.fish.enable = mkIf (user.shell.package == pkgs.fish) true;
    nix.settings.trusted-users = [ "${user.name}" ];

    users.groups.${user.name} = { };

    users.users.${user.name} = {
      initialHashedPassword = "$y$j9T$IoChbWGYRh.rKfmm0G86X0$bYgsWqDRkvX.EBzJTX.Z0RsTlwspADpvEF3QErNyCMC";
      isNormalUser = true;
      openssh.authorizedKeys.keys = [
        user.sshKey
      ];
      group = "${user.name}";
      extraGroups = [
        "wheel"
        "networkmanager"
      ];
      shell = user.shell.package;
    };

    home-manager = {
      useUserPackages = true;
      extraSpecialArgs = {
        inherit inputs;
        inherit user;
      };
      users.${user.name} = {
        programs.home-manager.enable = true;
        home = {
          username = "${user.name}";
          stateVersion = "24.05";
          homeDirectory = "${user.homeDir}";
        };
      };
    };
  };
}
