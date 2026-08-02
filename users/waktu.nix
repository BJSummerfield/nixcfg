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
      uid = 1000;

      hashedPasswordFile = config.sops.secrets."waktu/password_hash".path;
      sshKeys = {
        onepassword = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILtTarFZkhNoHtu39C6eCRaS84jb6SPoY92gn64Q2D3O";
        t495 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB7J5ZniIdU5XnuPLC4xB4bTuQpHMSWBWqfJ1NlJrewj waktu@t495";
        redtruck = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG6p+QgFfhPs3W2FWXLhtdn0d1ZUuXllOdbrmjglMr0K waktu@redtruck";
        mac = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIJvp5+k7aS98u1vw7Vg4qd8M4kTg8SrKT+q5rHEtcHz brian@mac.local";
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

