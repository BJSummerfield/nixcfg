{ pkgs, ... }:
{
  imports =
    [
      ./hardware-configuration.nix
      ./disko.nix
      ../../modules/nixos.nix
      ../../users/waktu.nix
      ../../users/sumriri.nix
      ../../users/sword.nix
    ];

  environment.systemPackages = with pkgs; [
    bottom
    git
    helix
  ];

  boot.initrd.systemd.enable = true;

  mine = {
    system = {
      hostName = "t495";
      externalInterface = "wlp1s0";
      renderGroupGid = 303;
      fish.enable = true;
      _1password.enable = true;
      avahi.enable = true;
      niri.enable = true;
      openssh.outbound.enable = true;
      coding-agents.enable = true;
      steam.enable = true;
      steambox.enable = true;
      theme = {
        enable = true;
        # Smaller fonts for the t495's higher-DPI screen.
        fontSizes = {
          applications = 10;
          terminal = 11;
          desktop = 10;
          popups = 9;
        };
      };
      tailscale = {
        enable = true;
        ssh = true;
      };
      teamspeak-client.enable = true;
    };
    users.waktu.authorizedKeys = [ "onepassword" "redtruck" "mac" ];
  };
  home-manager.users = {
    waktu = {
      mine.user = {
        _1password.enable = true;
        alacritty.enable = true;
        battery-notifications.enable = true;
        claude-code.enable = true;
        direnv.enable = true;
        firefox.enable = true;
        fish.enable = true;
        fuzzel.enable = true;
        gh.enable = true;
        git.enable = true;
        helix = {
          enable = true;
          lsp = {
            css.enable = true;
            html.enable = true;
            javascript.enable = true;
            json.enable = true;
            jsx.enable = true;
            kdl.enable = true;
            markdown.enable = true;
            nix.enable = true;
            rust.enable = true;
            toml.enable = true;
            tsx.enable = true;
            typescript.enable = true;
            yaml.enable = true;
          };
        };
        hyprlax.enable = true;
        keybase.enable = true;
        lazygit.enable = true;
        mako.enable = true;
        polkit-kde.enable = true;
        swayidle.enable = true;
        swaylock.enable = true;
      };
      programs = {
        eza.enable = true;
        starship.enable = true;
        zoxide.enable = true;
      };
      home.packages = with pkgs; [
        lumen
      ];
    };
    sumriri.mine.user.steambox.autoStart.enable = true;
    sword.mine.user.steambox.autoStart.enable = true;
  };
}
