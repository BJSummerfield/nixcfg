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

  # devbox container secrets. Both are bind-mounted read-only into the
  # container by modules/devbox/nixos.nix; neither ever enters the
  # container's filesystem or the nix store.
  #
  # The two modes differ deliberately and point opposite ways:
  #
  #   github-token   read by the *agent* (uid 1500, group users) at use
  #                  time, via the git credential helper and the gh
  #                  wrapper. sops-nix's default 0400 root is unreadable
  #                  to it, and `owner` can't help - it takes a host
  #                  username and no host user has uid 1500.
  #
  #   paseo-password read by PID 1 as root, via the paseo unit's
  #                  EnvironmentFile=, before the process drops to
  #                  User=agent. Root-only is sufficient and safer: it
  #                  keeps the daemon password out of reach of anything
  #                  running as agent, including a compromised agent.
  #
  # Rotating either one needs `systemctl restart container@devbox` - the
  # bind mount resolved to the old file when the container started.
  sops.secrets = {
    devbox-github-token = {
      sopsFile = ../../secrets/hosts/redtruck.yaml;
      mode = "0440";
      group = "users";
    };
    devbox-paseo-password.sopsFile = ../../secrets/hosts/redtruck.yaml;
    # SSH private key for commit signing. Loaded by the ssh-agent-devbox
    # systemd service at boot (runs as root), never read by agent uid.
    devbox-signing-key = {
      sopsFile = ../../secrets/hosts/redtruck.yaml;
      mode = "0400";
    };
  };

  mine = {
    system = {
      hostName = "redtruck";
      externalInterface = "enp34s0";
      renderGroupGid = 303;
      fish.enable = true;
      _1password.enable = true;
      avahi.enable = true;
      local-llm = {
        enable = true;
        cuda.enable = true;
      };
      makemkv.enable = true;
      nas = {
        shares.media.enable = true;
        shares.data.enable = true;
      };
      niri = {
        enable = true;
        hostConfig = ./niri.kdl;
      };
      nvidia.enable = true;
      openssh.outbound.enable = true;
      # coding-agents.enable = true;
      # Paths come from the sops.secrets declarations above rather than
      # being hardcoded, so a change to sops-nix's layout can't silently
      # desync them. The container stays autoStart = false until those
      # files exist on disk: a bindMount whose hostPath is missing fails
      # at container start, not at build.
      devbox = {
        enable = true;
        githubTokenFile = config.sops.secrets.devbox-github-token.path;
        paseoPasswordFile = config.sops.secrets.devbox-paseo-password.path;
        signingKeyFile = config.sops.secrets.devbox-signing-key.path;
        tailnetHostname = "devbox.mist-gamma.ts.net";
      };
      pipewire.sample-switch.enable = true;
      theme.enable = true;
      steam.enable = true;
      tailscale = {
        enable = true;
        ssh = true;
      };
      teamspeak-client.enable = true;
    };
    users.waktu.authorizedKeys = [ "onepassword" "t495" "mac" ];
  };
  home-manager.users = {
    waktu = { config, ... }: {
      mine.user = {
        _1password.enable = true;
        alacritty.enable = true;
        # claude-code.enable = true;
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
        paseo-desktop.enable = true;
        polkit-kde.enable = true;
        subtitleedit.enable = true;
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
        ffmpeg
        jellyfin-tui
        lumen
        nvtopPackages.nvidia
        picard
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

  # memoryPercent is a ceiling on the zram device, not a reservation - it only
  # consumes RAM as pages actually swap in. Machine-sized policy, so it lives
  # here rather than in the nvidia module.
  zramSwap = {
    enable = true;
    memoryPercent = 50;
  };

  systemd.tmpfiles.rules = [
    "d /games 0755 waktu users -"
    "d /media 0755 waktu users -"
    "d /data1 0755 waktu users -"
    "d /data2 0755 waktu users -"
  ];
}
