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
      hashedPasswordFile = config.sops.secrets."sumriri/password_hash".path;
    };
  };
}
