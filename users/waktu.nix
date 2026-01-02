{ modules ? [ ], ... }:
{
  description = "Brian Summerfield";
  isSuperUser = true;

  initialHashedPassword = "$y$j9T$IoChbWGYRh.rKfmm0G86X0$bYgsWqDRkvX.EBzJTX.Z0RsTlwspADpvEF3QErNyCMC";
  sshKeys = [
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILtTarFZkhNoHtu39C6eCRaS84jb6SPoY92gn64Q2D3O"
  ];

  home-modules = [
    {
      programs.git.settings = {
        user = {
          name = "BJSummerfield";
          email = "brianjsummerfield@gmail.com";
          signingkey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP2G3biYuL3iFvhAXYNuVzvRpAQMmFFLek3KFZV4PfDu";
        };
        gpg.format = "ssh";
        commit.gpgSign = true;
      };
    }
  ] ++ modules;
}
