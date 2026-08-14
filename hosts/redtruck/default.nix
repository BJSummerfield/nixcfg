{ config, pkgs, ... }:
{
  imports = [
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

  # Coding-agent container secrets, one set of three per container. Each set
  # is bind-mounted read-only into its own container by
  # modules/devbox/nixos.nix, onto the same three paths inside every
  # container (/run/secrets/github-token, /run/secrets/paseo-password and
  # /run/secrets/signing-key); no secret ever enters a container's
  # filesystem or the nix store.
  #
  # The two containers exist to hold two different GitHub tokens, so the
  # token files are what actually distinguishes them.
  #
  # The three modes differ deliberately:
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
  #   signing-key    read by the agent via `ssh-keygen -Y sign`, which
  #                  ignores any key a group or other bit can reach. That
  #                  rules out the 0440/group trick: 0400 owned by uid 1500,
  #                  set numerically since `owner` takes a host username.
  #
  # Each container gets its own signing key, so a commit's signature says
  # which box made it.
  #
  # Rotating any of them needs `systemctl restart container@<name>` - the
  # bind mount resolved to the old file when the container started.
  sops.secrets = {
    devbox-github-token = {
      sopsFile = ../../secrets/hosts/redtruck.yaml;
      mode = "0440";
      group = "users";
    };
    devbox-paseo-password.sopsFile = ../../secrets/hosts/redtruck.yaml;
    devbox-signing-key = {
      sopsFile = ../../secrets/hosts/redtruck.yaml;
      mode = "0400";
      uid = 1500;
    };
    workbox-github-token = {
      sopsFile = ../../secrets/hosts/redtruck.yaml;
      mode = "0440";
      group = "users";
    };
    workbox-paseo-password.sopsFile = ../../secrets/hosts/redtruck.yaml;
    workbox-signing-key = {
      sopsFile = ../../secrets/hosts/redtruck.yaml;
      mode = "0400";
      uid = 1500;
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
      # Paths come from the sops.secrets declarations above rather than
      # being hardcoded, so a change to sops-nix's layout can't silently
      # desync them. Addresses are stated per instance so a collision
      # between the two is visible right here rather than showing up as a
      # container that starts and then cannot route.
      devboxes = {
        devbox = {
          githubTokenFile = config.sops.secrets.devbox-github-token.path;
          paseoPasswordFile = config.sops.secrets.devbox-paseo-password.path;
          signingKeyFile = config.sops.secrets.devbox-signing-key.path;
          tailnetHostname = "devbox.mist-gamma.ts.net";
          hostAddress = "192.168.100.26";
          localAddress = "192.168.100.27";
        };
        workbox = {
          githubTokenFile = config.sops.secrets.workbox-github-token.path;
          paseoPasswordFile = config.sops.secrets.workbox-paseo-password.path;
          signingKeyFile = config.sops.secrets.workbox-signing-key.path;
          tailnetHostname = "workbox.mist-gamma.ts.net";
          hostAddress = "192.168.100.28";
          localAddress = "192.168.100.29";
        };
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
    users.waktu.authorizedKeys = [
      "onepassword"
      "t495"
      "mac"
    ];
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
