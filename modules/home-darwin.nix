# Darwin-safe home-manager modules; Linux-only options prevent importing the full set.
{ ... }: {
  imports = [
    ./alacritty/home.nix
    ./direnv/home.nix
    ./fish/home.nix
    ./gh/home.nix
    ./git/home.nix
    ./hammerspoon/home.nix
    ./helix/home.nix
    ./lazygit/home.nix
    ./opencode/home.nix
    ./paseo-desktop/home.nix
    ./unfree/home.nix
  ];
}
