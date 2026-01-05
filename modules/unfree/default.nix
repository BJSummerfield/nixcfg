{ lib, config, ... }:
{
  options.mine.allowedUnfree = lib.mkOption {
    type = lib.types.listOf lib.types.str;
    default = [ ];
    description = "List of unfree packages to allow.";
  };
  config = {
    nixpkgs.config.allowUnfreePredicate = pkg:
      builtins.elem (lib.getName pkg) config.mine.allowedUnfree;
  };
}
