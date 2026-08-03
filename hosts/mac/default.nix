{ pkgs, ... }:
{
  imports = [
    ../../modules/darwin.nix
  ];

  nixpkgs.hostPlatform = "aarch64-darwin";

  system.primaryUser = "brian";
  system.defaults.dock = {
    autohide = true;
    autohide-delay = 0.0;
    show-recents = false;
    autohide-time-modifier = 0.0;
    tilesize = 1;
  };

  users.knownUsers = [ "brian" ];
  users.users.brian = {
    name = "brian";
    home = "/Users/brian";
    uid = 501;
    shell = pkgs.fish;
  };

  mine.system = {
    _1password.enable = true;
    firefox.enable = true;
    keybase.enable = true;
    coding-agents.enable = true;
    theme.fontSizes.terminal = 15;
  };

  environment.systemPackages = with pkgs; [
    ffmpeg
  ];

  # Mac-only apps; anything shared with the nixos hosts is cask-managed
  # by its module instead.
  homebrew = {
    casks = [
      "docker-desktop"
      "hammerspoon"
      "microsoft-teams"
      "tailscale-app"
      "utm"
    ];
  };

  home-manager.users.brian = {
    home.stateVersion = "24.11";
    mine.user = {
      alacritty.enable = true;
      claude-code.enable = true;
      direnv.enable = true;
      fish.enable = true;
      gh.enable = true;
      git.enable = true;
      hammerspoon.enable = true;
      helix = {
        enable = true;
        lsp = {
          bicep.enable = true;
          css.enable = true;
          html.enable = true;
          javascript.enable = true;
          json.enable = true;
          jsx.enable = true;
          markdown.enable = true;
          nix.enable = true;
          rust.enable = true;
          toml.enable = true;
          tsx.enable = true;
          typescript.enable = true;
          yaml.enable = true;
        };
      };
      lazygit.enable = true;
    };
    programs = {
      eza.enable = true;
      starship.enable = true;
      zoxide.enable = true;
      git.settings = {
        user = {
          name = "BJSummerfield";
          email = "brianjsummerfield@gmail.com";
          signingkey = "/Users/brian/.ssh/id_ed25519.pub";
        };
        gpg.format = "ssh";
        commit.gpgSign = true;
      };
    };
    home.packages = with pkgs; [
      lumen
    ];
  };
}
