{ lib, config, pkgs, ... }:
let
  cfg = config.mine.system.jellybox;
  jellyfinBin = lib.getExe pkgs.jellyfin-media-player;
  jellyfinKiosk = pkgs.writeShellScript "jellyfin-kiosk" ''
    exec ${lib.getExe pkgs.gamescope} -f -- ${jellyfinBin} --fullscreen --tv
  '';
in
{

  options.mine.system.jellybox.enable = lib.mkEnableOption "Jellybox system dependencies";

  config = lib.mkIf cfg.enable {
    services.greetd = {
      enable = true;
      settings = {
        initial_session = {
          command = "${jellyfinKiosk}";
          user = "jellyuser";
        };
        # Quit Jellyfin -> the appliance comes straight back (no prompt).
        # During bring-up you may prefer a recoverable prompt instead; swap the
        # block below for:
        #   default_session.command =
        #     "${pkgs.greetd.greetd}/bin/agreety --cmd ${pkgs.fish}/bin/fish";
        default_session = {
          command = "${jellyfinKiosk}";
          user = "jellyuser";
        };
      };
    };

    # closing the lid shouldn't kill playback when docked / on AC.
    services.logind.settings.Login.HandleLidSwitch = lib.mkDefault "suspend";
    services.logind.settings.Login.HandleLidSwitchDocked = lib.mkDefault "ignore";
    services.logind.settings.Login.HandleLidSwitchExternalPower = lib.mkDefault "ignore";

    mine.system.gamescope.enable = true;

    environment.systemPackages = [ pkgs.jellyfin-media-player ];
    specialisation.maintenance.configuration = {
      services.greetd.enable = lib.mkForce false;
      services.logind.settings.Login.HandleLidSwitch = lib.mkForce "suspend";
      services.logind.settings.Login.HandleLidSwitchDocked = lib.mkForce "suspend";
      services.logind.settings.Login.HandleLidSwitchExternalPower = lib.mkForce "suspend";
    };
  };
}
