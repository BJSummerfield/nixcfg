{ config, pkgs, ... }:
{
  imports =
    [
      ./hardware-configuration.nix
      ./disko.nix
      ../../modules/nixos.nix
      ../../users/waktu.nix
    ];

  environment.systemPackages = with pkgs; [
    bottom
    git
    helix
  ];

  mine = {
    system = {
      hostName = "redtruck";
      externalInterface = "enp34s0";
      renderGroupGid = 303;
      fish.enable = true;
      _1password.enable = true;
      avahi.enable = true;
      local-llm.enable = true;
      makemkv.enable = true;
      nas = {
        shares.media.enable = true;
        shares.data.enable = true;
      };
      niri = {
        enable = true;
        hostConfig = ./niri.kdl;
      };
      openssh.outbound.enable = true;
      pipewire.sample-switch.enable = true;
      printing.enable = true;
      stylix.enable = true;
      steam.enable = true;
      tailscale = {
        enable = true;
        ssh = true;
      };
      teamspeak-client.enable = true;
    };
    users.waktu.authorizedKeys = [ "onepassword" "t495" ];
  };
  home-manager.users = {
    waktu = { config, ... }: {
      mine.user = {
        _1password.enable = true;
        alacritty.enable = true;
        direnv.enable = true;
        encode_queue.enable = true;
        firefox.enable = true;
        fish.enable = true;
        fuzzel.enable = true;
        gh.enable = true;
        git.enable = true;
        helix = {
          enable = true;
          lsp = {
            bicep.enable = true;
            css.enable = true;
            graphql.enable = true;
            html.enable = true;
            javascript.enable = true;
            json.enable = true;
            jsx.enable = true;
            markdown.enable = true;
            nix.enable = true;
            python.enable = true;
            rust.enable = true;
            toml.enable = true;
            tsx.enable = true;
            typescript = {
              enable = true;
              formatter = "prettier";
            };
            yaml.enable = true;
          };
        };
        hyprlax.enable = true;
        keybase.enable = true;
        lazygit.enable = true;
        mako.enable = true;
        obs-studio.enable = true;
        opencode.enable = true;
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
        abcde
        amdgpu_top
        ffmpeg
        jellyfin-tui
        picard
        subtitleedit
      ];
      home.file =
        let
          mkLink = config.lib.file.mkOutOfStoreSymlink;
        in
        {
          "media".source = mkLink "/media";
          "games".source = mkLink "/games";
          "data1".source = mkLink "/data1";
          "data2".source = mkLink "/data2";
        };
    };
  };

  systemd.tmpfiles.rules = [
    "d /games 0755 waktu users -"
    "d /media 0755 waktu users -"
    "d /data1 0755 waktu users -"
    "d /data2 0755 waktu users -"
  ];
}
