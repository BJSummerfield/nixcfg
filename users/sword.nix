{ config, ... }:
{
  config = {
    sops.secrets."sword/password_hash" = {
      sopsFile = ../secrets/users/sword.yaml;
      key = "password_hash";
      neededForUsers = true;
    };

    mine.users.sword = {
      description = "Martin";
      uid = 1002;
      hashedPasswordFile = config.sops.secrets."sword/password_hash".path;
    };
  };
}
