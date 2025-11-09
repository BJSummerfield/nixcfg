{ ... }: {
  imports = [
    ./bicep-langserver.nix
    ./direnv
    ./eza
    ./gh
    ./git
    ./helix
    ./jellyfin-tui.nix
    ./lazygit
    ./mpls.nix
    ./starship
    ./zoxide
    ./tailscale.nix
    ./gamescope.nix
    ./encode_queue.nix
  ];
}
