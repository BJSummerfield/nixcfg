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

  mine.system.pi-coding-agent.enable = true;
  mine.allowedUnfree = [ "1password-cli" ];

  environment.systemPackages = with pkgs; [
    _1password-cli
    ffmpeg
  ];

  homebrew = {
    brews = [ "libaacs" ];
    casks = [
      "1password"
      "docker-desktop"
      "firefox"
      "hammerspoon"
      "keybase"
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
