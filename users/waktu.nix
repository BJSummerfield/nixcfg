{ config, ... }:
{
  config = {
    sops.secrets."waktu/password_hash" = {
      sopsFile = ../secrets/users/waktu.yaml;
      key = "password_hash";
      neededForUsers = true;
    };

    mine.users.waktu = {
      description = "Brian Summerfield";
      isSuperUser = true;

      hashedPasswordFile = config.sops.secrets."waktu/password_hash".path;
      sshKeys = {
        onepassword = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILtTarFZkhNoHtu39C6eCRaS84jb6SPoY92gn64Q2D3O";
        t495 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAiPGYO7ptuhbBGRgJ7QDnPgElAE3osPpNnaDO7LzUAT waktu@t495";
        redtruck = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEvWKbVlR1wVy+xZdkwMbD9mcYPB8yLfYBr3LpteDNMj waktu@redtruck";
      };
      nasAccess = {
        media = "rw";
        homes = "ro";
      };

      home-modules = [
        {
          programs.git.settings = {
            user = {
              name = "BJSummerfield";
              email = "brianjsummerfield@gmail.com";
              signingkey = "/home/waktu/.ssh/id_ed25519.pub";
            };
            gpg.format = "ssh";
            commit.gpgSign = true;
          };
        }
      ];
    };
  };
}

