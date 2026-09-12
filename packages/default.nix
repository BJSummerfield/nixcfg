{ pkgs }:
{
  encode_queue = pkgs.callPackage ../modules/encode_queue/package.nix { };
  keybase-notify = pkgs.callPackage ../modules/keybase-notify/package.nix { };
  caddy-l4 = pkgs.callPackage ../modules/caddy/package.nix { };
  photoform = pkgs.callPackage ../modules/photoform/package.nix { };
}
