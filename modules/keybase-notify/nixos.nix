{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.system.keybase-notify;
in
{
  options.mine.system.keybase-notify = {
    enable = lib.mkEnableOption "posting notifications to a Keybase chat via webhookbot";

    urlFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = ''
        Host path to a file containing the Keybase webhookbot URL. A string
        rather than a path, so a Nix path literal (which would be copied
        into the world-readable store) is rejected. `null` means log only.
      '';
    };

    prefix = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "Text prepended to every message.";
    };

    package = lib.mkOption {
      type = lib.types.package;
      readOnly = true;
      default = pkgs.callPackage ./package.nix {
        urlFile = if cfg.urlFile == null then "" else cfg.urlFile;
        inherit (cfg) prefix;
      };
      description = "The keybase-notify package, built with this host's urlFile and prefix baked in.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];
  };
}
