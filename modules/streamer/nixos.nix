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
  usbId = lib.splitString ":" cfg.usbId;
  vendor = lib.head usbId;
  product = lib.last usbId;
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

    usbId = mkOption {
      type = types.strMatching "[0-9a-f]{4}:[0-9a-f]{4}";
      example = "2972:0099";
      description = "USB vendor:product ID (as shown by lsusb) of the audio device to play to.";
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = config.mine.system.externalInterface != null;
        message = "mine.system.streamer.enable requires mine.system.externalInterface to be set.";
      }
    ];

    services.udev.extraRules = ''
      SUBSYSTEM=="sound", ACTION=="add", KERNEL=="card*", ATTRS{idVendor}=="${vendor}", ATTRS{idProduct}=="${product}", ATTR{id}!="dac", ATTR{id}="dac", RUN+="${config.systemd.package}/bin/systemctl --no-block restart gmediarender.service"
      SUBSYSTEM=="sound", ACTION=="remove", KERNEL=="card*", ATTR{id}=="dac", RUN+="${config.systemd.package}/bin/systemctl --no-block stop gmediarender.service"
    '';

    services.gmediarender = {
      enable = true;
      friendlyName = cfg.name;
      audioSink = "alsasink";
      audioDevice = device;
      port = 49494;
      inherit uuid;
      package = pkgs.symlinkJoin {
        name = "gmediarender-${config.mine.system.externalInterface}";
        paths = [ pkgs."gmrender-resurrect" ];
        nativeBuildInputs = [ pkgs.makeWrapper ];
        postBuild = ''
          wrapProgram $out/bin/gmediarender \
            --append-flag "--interface-name=${config.mine.system.externalInterface}"
        '';
      };
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
