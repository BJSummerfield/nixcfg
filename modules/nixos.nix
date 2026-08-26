{ inputs, ... }: {
  imports = [
    inputs.sops-nix.nixosModules.sops
    ./_1password/nixos.nix
    ./avahi/nixos.nix
    ./backups/nixos.nix
    ./caddy/nixos.nix
    ./dns-server/nixos.nix
    ./docker/nixos.nix
    ./filesystems
    ./fish/nixos.nix
    ./gamescope/nixos.nix
    ./immich-server/nixos.nix
    ./jellyfin-server/nixos.nix
    ./jellybox/nixos.nix
    ./local-llm/nixos.nix
    ./makemkv/nixos.nix
    ./niri/nixos.nix
    ./nvidia/nixos.nix
    ./openssh/nixos.nix
    ./devbox/nixos.nix
    ./pipewire/nixos.nix
    ./photoform/nixos.nix
    ./printing/nixos.nix
    ./stalwart-server/nixos.nix
    ./steam/nixos.nix
    ./steambox/nixos.nix
    ./system/nixos.nix
    ./tailscale/nixos.nix
    ./teamspeak-client/nixos.nix
    ./teamspeak-server/nixos.nix
    ./terraria-server/nixos.nix
    ./theme/nixos.nix
    ./unfree/nixos.nix
    ./users/nixos.nix
    ./vikunja-server/nixos.nix
  ];

  home-manager.sharedModules = [
    ./home.nix
  ];
}
