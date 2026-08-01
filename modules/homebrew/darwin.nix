# Homebrew handles the GUI apps that nixpkgs doesn't package well for
# darwin (1Password, Firefox, Docker Desktop, ...). Casks are declared
# per-host; anything not declared is uninstalled on activation.
{ config, inputs, ... }:
{
  imports = [
    inputs.nix-homebrew.darwinModules.nix-homebrew
  ];

  nix-homebrew = {
    enable = true;
    enableRosetta = true;
    user = config.system.primaryUser;
  };

  homebrew = {
    enable = true;
    onActivation = {
      autoUpdate = true;
      cleanup = "uninstall";
      upgrade = true;
    };
  };
}
