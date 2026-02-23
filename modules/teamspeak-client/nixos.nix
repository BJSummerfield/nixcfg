{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.system.teamspeak-client;
in
{
  options.mine.system.teamspeak-client.enable = mkEnableOption "Enable Teamspeak Client";

  config = mkIf cfg.enable {

    mine.allowedUnfree = [
      "teamspeak6-client"
    ];
    environment.systemPackages = [ pkgs.teamspeak6-client ];
  };
}
