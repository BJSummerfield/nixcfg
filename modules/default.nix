{ ... }: {
  imports = [
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
    ./lazygit
    ./git
    ./tailscale
    ./openssh
    ./xwayland-satellite
  ];
}
