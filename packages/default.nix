{ pkgs }:
{
  encode_queue = pkgs.callPackage ../modules/encode_queue/package.nix { };
  keybase-notify = pkgs.callPackage ../modules/keybase-notify/package.nix { };
  onePassword = pkgs.callPackage ./onePassword.nix { };
}
