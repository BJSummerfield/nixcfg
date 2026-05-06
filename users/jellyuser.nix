{ config, ... }:
{
  config = {
    sops.secrets."jellyfin/password_hash" = {
      sopsFile = ../secrets/users/jellyfin.yaml;
      key = "password_hash";
      neededForUsers = true;
    };

    mine.users.jellyfin = {
      description = "jellyfin user";
      hashedPasswordFile = config.sops.secrets."jellyfin/password_hash".path;
    };
  };
}
