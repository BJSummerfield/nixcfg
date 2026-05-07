{ config, ... }:
{
  config = {
    sops.secrets."jellyuser/password_hash" = {
      sopsFile = ../secrets/users/jellyuser.yaml;
      key = "password_hash";
      neededForUsers = true;
    };

    mine.users.jellyuser = {
      description = "jellyfin user";
      hashedPasswordFile = config.sops.secrets."jellyuser/password_hash".path;
    };
  };
}
