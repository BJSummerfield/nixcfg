# Home-manager modules safe to import on darwin. This is a subset of
# home.nix: modules that set Linux-only HM options (systemd.user, wayland
# services, services.keybase, ...) cannot even be imported here, because
# home-manager only declares those options on Linux.
{ ... }: {
  imports = [
    ./alacritty/home.nix
    ./bicep-langserver/home.nix
    ./direnv/home.nix
    ./fish/home.nix
    ./gh/home.nix
    ./git/home.nix
    ./hammerspoon/home.nix
    ./helix/home.nix
    ./lazygit/home.nix
    ./mpls/home.nix
    ./opencode/home.nix
    ./unfree/home.nix
  ];
}
