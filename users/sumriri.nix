{ config, ... }:
{
  config = {
    sops.secrets."sumriri/password_hash" = {
      sopsFile = ../secrets/users/sumriri.yaml;
      key = "password_hash";
      neededForUsers = true;
    };

    mine.users.sumriri = {
      description = "Ryker";
      uid = 1001;
      hashedPasswordFile = config.sops.secrets."sumriri/password_hash".path;
    };
  };
}
