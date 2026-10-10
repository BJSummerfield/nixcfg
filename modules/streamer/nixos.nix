{
  lib,
  pkgs,
  config,
  ...
}:
let
  inherit (lib)
    mkEnableOption
    mkIf
    mkOption
    types
    ;
  cfg = config.mine.system.streamer;
  device = "hw:CARD=dac,DEV=0";
  uuid = lib.concatStringsSep "-" (
    builtins.match "(.{8})(.{4})(.{4})(.{4})(.{12})" (
      builtins.hashString "md5" config.networking.hostName
    )
  );
in
{
  options.mine.system.streamer = {
    enable = mkEnableOption "a bit-perfect UPnP and AirPlay renderer on the USB audio output";

    name = mkOption {
      type = types.str;
      default = "Desk";
      description = "Name the renderer advertises to UPnP and AirPlay clients.";
    };
  };

  config = mkIf cfg.enable {
    services.udev.extraRules = ''
      SUBSYSTEM=="sound", ACTION=="add", KERNEL=="card*", SUBSYSTEMS=="usb", ATTR{id}!="dac", ATTR{id}="dac"
    '';

    services.gmediarender = {
      enable = true;
      friendlyName = cfg.name;
      audioSink = "alsasink";
      audioDevice = device;
      port = 49494;
      inherit uuid;
    };

    systemd.services.gmediarender.environment.GIO_EXTRA_MODULES =
      "${pkgs.glib-networking}/lib/gio/modules";

    services.shairport-sync = {
      enable = true;
      openFirewall = true;
      settings = {
        general = {
          inherit (cfg) name;
          output_backend = "alsa";
          ignore_volume_control = "yes";
        };
        alsa.output_device = device;
        sessioncontrol = {
          run_this_before_play_begins = "${config.systemd.package}/bin/systemctl restart gmediarender.service";
          wait_for_completion = "yes";
        };
      };
    };

    security.polkit.extraConfig = ''
      polkit.addRule(function(action, subject) {
        if (action.id == "org.freedesktop.systemd1.manage-units" &&
            action.lookup("unit") == "gmediarender.service" &&
            action.lookup("verb") == "restart" &&
            subject.user == "${config.services.shairport-sync.user}") {
          return polkit.Result.YES;
        }
      });
    '';

    mine.system.avahi.enable = true;

    networking.firewall = {
      allowedTCPPorts = [ config.services.gmediarender.port ];
      allowedUDPPorts = [ 1900 ];
    };
  };
}
