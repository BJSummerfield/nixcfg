{ config, ... }:
{
  config = {
    sops.secrets."link/password_hash" = {
      sopsFile = ../secrets/users/link.yaml;
      key = "password_hash";
      neededForUsers = true;
    };

    mine.users.link = {
      description = "Martin";
      hashedPasswordFile = config.sops.secrets."link/password_hash".path;
    };
  };
}
