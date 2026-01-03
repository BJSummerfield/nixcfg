{ ... }:
{
  description = "Dummy User";

  initialHashedPassword = "$6$C5E4jol/3DfO9Jti$xumTLCQOqi9yfGC.WA6Yji.Brw/.whLWBgo7tqqMNPEaV2/MvePsOqkjgjL3zuPgkAc0mC80so2bIPbeSV4jB1";
  # sshKeys = [
  #   "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILtTarFZkhNoHtu39C6eCRaS84jb6SPoY92gn64Q2D3O"
  # ];

  # home-modules = [
  #   {
  #     programs.git.settings = {
  #       user = {
  #         name = "BJSummerfield";
  #         email = "brianjsummerfield@gmail.com";
  #         signingkey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP2G3biYuL3iFvhAXYNuVzvRpAQMmFFLek3KFZV4PfDu";
  #       };
  #       gpg.format = "ssh";
  #       commit.gpgSign = true;
  #     };
  #   }
  # ] ++ modules;
}
