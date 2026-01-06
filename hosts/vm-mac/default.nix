{ pkgs, ... }:
{
  imports =
    [
      ./hardware-configuration.nix
      ../../modules/nixos.nix
      ../../users/waktu.nix
    ];

  environment.systemPackages = with pkgs; [
    bottom
    git
    helix
  ];

  mine = {
    allowedUnfree = [ "prl-tools" ];
    system = {
      hostName = "vm-mac";
      fish.enable = true;
      _1password.enable = true;
      niri.enable = true;
    };
  };
  home-manager.users = {
    waktu = {
      mine.user = {
        _1password = {
          enable = true;
          sshAgent.enable = true;
          gitSigning.enable = true;
          ghPlugin.enable = true;
        };
        alacritty.enable = true;
        catppuccin.enable = true;
        direnv.enable = true;
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
        lazygit.enable = true;
        mako.enable = true;
        polkit-gnome.enable = true;
        stylix.enable = true;
        swaybg.enable = true;
      };
      programs = {
        eza.enable = true;
        starship.enable = true;
        zoxide.enable = true;
      };
    };
  };
}

