{ ... }: {
  imports = [
    ./_1password.nix
    ./alacritty.nix
    ./docker.nix
    ./firefox.nix
    ./ghostty.nix
    ./jellyfin
    ./keybase.nix
    ./obs-studio.nix
    ./printer.nix
    ./steam.nix
  ];
}
