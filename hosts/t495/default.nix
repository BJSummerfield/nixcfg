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
      printing.enable = true;
      steam.enable = true;
      steambox.enable = true;
      stylix.enable = true;
      tailscale = {
        enable = true;
        ssh = true;
      };
      teamspeak-client.enable = true;
    };
    users.waktu.authorizedKeys = [ "onepassword" "redtruck" ];
  };
  home-manager.users = {
    waktu = {
      mine.user = {
        _1password.enable = true;
        alacritty.enable = true;
        battery-notifications.enable = true;
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
        opencode.enable = true;
        opencode.robinllm.enable = true;
        polkit-kde.enable = true;
        swayidle.enable = true;
        swaylock.enable = true;
      };
      programs = {
        eza.enable = true;
        starship.enable = true;
        zoxide.enable = true;
      };
    };
    sumriri.mine.user.steambox.autoStart.enable = true;
    sword.mine.user.steambox.autoStart.enable = true;
  };
}
