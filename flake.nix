{
  inputs = {
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    catppuccin.url = "github:catppuccin/nix";
    stylix.url = "github:danth/stylix";
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    _1password-shell-plugins.url = "github:1Password/shell-plugins";
  };

  outputs = { nixpkgs, ... }@inputs:
    {
      nixosConfigurations = {
        t495 = nixpkgs.lib.nixosSystem {
          specialArgs = {
            inherit inputs;
          };
          modules = [ ./hosts/t495 ];
        };
        redtruck = nixpkgs.lib.nixosSystem {
          specialArgs = {
            inherit inputs;
          };
          modules = [ ./hosts/redtruck ];
        };
        vm-mac = nixpkgs.lib.nixosSystem {
          specialArgs = {
            inherit inputs;
          };
          modules = [ ./hosts/vm-mac ];
        };
        elitebook = nixpkgs.lib.nixosSystem {
          specialArgs = {
            inherit inputs;
          };
          modules = [ ./hosts/elitebook ];
        };
      };
    };
}
