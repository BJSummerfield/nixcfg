{ ... }:
{
  config.mine.users.waktu = {
    description = "Brian Summerfield";
    isSuperUser = true;

    initialHashedPassword = "$y$j9T$IoChbWGYRh.rKfmm0G86X0$bYgsWqDRkvX.EBzJTX.Z0RsTlwspADpvEF3QErNyCMC";
    sshKeys = {
      onepassword = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILtTarFZkhNoHtu39C6eCRaS84jb6SPoY92gn64Q2D3O";
      t495 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFgkxPsobIniuj+jWkUQCS2nCRfOAOaJdIXqExtNV7QD waktu@t495";
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
}
