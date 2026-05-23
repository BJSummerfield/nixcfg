{ config, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf mkOption types;
  cfg = config.mine.system._1password;

  # allowedUsers is the names of all users that have 1password enabled
  hmUsers = config.home-manager.users;
  usersWith1Pass = lib.filterAttrs
    (name: userConfig: userConfig.mine.user._1password.enable or false)
    hmUsers;
  allowedUsers = lib.attrNames usersWith1Pass;
in
{
  options.mine.system._1password = {
    enable = mkEnableOption "1Password System Integration";
    overlay = {
      enable = mkEnableOption "1Password Source Overlay (workaround for upstream hash mismatch)";
      url = mkOption {
        type = types.str;
        default = "https://downloads.1password.com/linux/tar/stable/x86_64/1password-8.12.21.x64.tar.gz";
        description = "Tarball URL used when the overlay is enabled.";
      };
      hash = mkOption {
        type = types.str;
        default = "sha256-JwiMi2iozP6jWSIUtgXla86aSAhuUob7snqtUbeXPpI=";
        description = "SRI hash of the tarball used when the overlay is enabled.";
      };
    };
  };
  config = mkIf cfg.enable {
    mine.allowedUnfree = [
      "1password"
      "1password-cli"
    ];
    programs._1password.enable = true;
    programs._1password-gui = {
      enable = true;
      polkitPolicyOwners = allowedUsers;
    };

    # Apply overlay if needed
    nixpkgs.overlays = lib.optionals cfg.overlay.enable [
      (self: super: {
        _1password-gui = super._1password-gui.overrideAttrs (old: {
          src = super.fetchurl {
            url = cfg.overlay.url;
            hash = cfg.overlay.hash;
          };
        });
      })
    ];
  };
}
