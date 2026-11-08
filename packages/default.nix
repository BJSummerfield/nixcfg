{ pkgs }:
{
  ari_photo = pkgs.callPackage ../modules/ari-photo/package.nix { };
  encode_queue = pkgs.callPackage ../modules/encode_queue/package.nix { };
  keybase-notify = pkgs.callPackage ../modules/keybase-notify/package.nix { };
}
