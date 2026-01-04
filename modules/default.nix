{ ... }: {
  imports = [
    ./docker
    ./_1password
    ./polkit_gnome
    ./alacritty
    ./fuzzel
    ./niri
    # ./apps
    # ./user
    ./system
    # ./encoding
    # ./cli-tools
    # ./desktop
    ./fish
    ./firefox
    ./lazygit
    ./git
    ./tailscale
    ./openssh
    ./xwayland-satellite
  ];
}
