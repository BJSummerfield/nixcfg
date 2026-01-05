{ ... }: {
  imports = [
    ./_1password/nixos.nix
    ./avahi/nixos.nix
    ./docker/nixos.nix
    ./fish/nixos.nix
    ./gamescope/nixos.nix
    ./makemkv/nixos.nix
    ./niri/nixos.nix
    ./openssh/nixos.nix
    ./printing/nixos.nix
    ./steam/nixos.nix
    ./system/nixos.nix
    ./tailscale/nixos.nix
    ./unfree
    ./users/nixos.nix
  ];

  home-manager.sharedModules = [
    ./home.nix
  ];
}
