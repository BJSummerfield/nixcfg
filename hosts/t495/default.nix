{ ... }:
{
  imports =
    [
      ./hardware-configuration.nix
      ../../modules
    ];

  config = {
    mine = {
      system = {
        hostName = "t495";
        bootPartitionUuid = "5cccbb79-6ae4-4a43-add1-9b5fa0a03e18";
        fonts.enable = true;
        ssh = {
          enable = true;
        };
      };
      apps = {
        alacritty.enable = true;
      };
      cli-tools = {
        direnv.enable = true;
        eza.enable = true;
        git.enable = true;
        lazygit.enable = true;
        starship.enable = true;
        zoxide.enable = true;
        helix = {
          enable = true;
          lsp = {
            bicep.enable = true;
            graphql.enable = true;
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
      };
    };
  };
}
