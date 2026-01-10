{ ... }:
{
  config.mine.users.sumriri = {
    description = "Ryker";
    initialHashedPassword = "$6$fuU2Mo77wD.TUQJB$0u66e9w/vb66UKCFzc8YJVOn60Cznn7sGx9kxBXmuYzpVe1HVfZwPxtOSVdoKX925kxtFrgEJyyi6ZfbuIl6U1";
    home-modules = [
      {
        programs.fish.loginShellInit = ''
          if test -z "$WAYLAND_DISPLAY" -a "$XDG_VTNR" = 1
            exec gamescope -W 1920 -H 1080 -r 60 \
            -f -e --xwayland-count 2 \
            -- steam -gamepadui 
          end
        '';
      }
    ];
  };

}
