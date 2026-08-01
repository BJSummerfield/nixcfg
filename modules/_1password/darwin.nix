{ pkgs, lib, config, ... }:
let
  cfg = config.mine.system._1password;
in
{
  options.mine.system._1password.enable = lib.mkEnableOption "1Password app and CLI";

  config = lib.mkIf cfg.enable {
    mine.allowedUnfree = [ "1password-cli" ];
    homebrew.casks = [ "1password" ];
    environment.systemPackages = [ pkgs._1password-cli ];
  };
}
