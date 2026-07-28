{ config, lib, ... }:
let
  cfg = config.mine.system.niri;
in
{
  options.mine.system.niri = {
    enable = lib.mkEnableOption "Enable niri config";

    hostConfig = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Path to a host-specific niri KDL file. Deployed to
        /etc/niri/host.kdl and pulled in by the user-level config
        via `include optional=true`.
      '';
    };
  };

  config = lib.mkIf cfg.enable (lib.mkMerge [
    {
      environment.sessionVariables.NIXOS_OZONE_WL = "1";
      programs.niri.enable = true;
      # niri requires libdisplay-info < 0.4.0, but nixpkgs bumped it to 0.4.0.
      # Remove once nixpkgs c0882363 (niri: pin libdisplay-info_0_3) reaches
      # nixos-unstable.
      nixpkgs.overlays = [
        (self: super: {
          libdisplay-info = super.libdisplay-info.overrideAttrs {
            version = "0.3.0";
            src = super.fetchFromGitLab {
              domain = "gitlab.freedesktop.org";
              owner = "emersion";
              repo = "libdisplay-info";
              rev = "0.3.0";
              sha256 = "sha256-nXf2KGovNKvcchlHlzKBkAOeySMJXgxMpbi5z9gLrdc=";
            };
          };
        })
      ];
      home-manager.sharedModules = [{ mine.user.niri.enable = true; }];
    }

    (lib.mkIf (cfg.hostConfig != null) {
      environment.etc."niri/host.kdl".source = cfg.hostConfig;
    })
  ]);
}
