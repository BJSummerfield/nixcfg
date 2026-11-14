{ lib, ... }:
{
  options.mine.allowedUnfree = lib.mkOption {
    type = lib.types.listOf lib.types.str;
    default = [ ];
    description = ''
      List of unfree package names (as returned by `lib.getName`) that are
      allowed to be built. Settable in NixOS modules and home-manager modules;
      home-manager values are propagated up to NixOS scope by the users module.
    '';
  };

  options.mine.allowedInsecure = lib.mkOption {
    type = lib.types.listOf lib.types.str;
    default = [ ];
    description = ''
      List of insecure packages (name and version, as in
      `nixpkgs.config.permittedInsecurePackages`) that are allowed to be
      built. Settable in NixOS modules and home-manager modules;
      home-manager values are propagated up to NixOS scope by the users module.
    '';
  };
}
