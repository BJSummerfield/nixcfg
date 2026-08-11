{ lib, config, ... }:
{
  imports = [ ./options.nix ];

  config.nixpkgs.config.allowUnfreePredicate =
    pkg: builtins.elem (lib.getName pkg) config.mine.allowedUnfree;
}
