{ ... }:
{
  config.mine.users.link = {
    description = "Martin";
    initialHashedPassword = "$y$j9T$HtGcPgOzaeTS8KN3YLr5u1$K2kgyoNKP8i4SgkI0wAZFBDfmYuJYAKl1Cta7gINwp5";
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
