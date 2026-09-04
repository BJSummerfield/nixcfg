{
  inputs = {
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    disko = {
      url = "github:nix-community/disko";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    sops-nix = {
      url = "github:Mic92/sops-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nix-darwin = {
      url = "github:nix-darwin/nix-darwin/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nix-homebrew.url = "github:zhaofengli-wip/nix-homebrew";
    # Trampoline app bundles for nix-installed apps so Spotlight can index
    # them (it refuses to follow the symlinks home-manager makes).
    mac-app-util = {
      url = "github:hraban/mac-app-util";
      # collapse its transitive pins (incl. two extra full nixpkgs
      # snapshots) onto ours so every host isn't fetching dead weight
      inputs = {
        nixpkgs.follows = "nixpkgs";
        treefmt-nix.inputs.nixpkgs.follows = "nixpkgs";
        cl-nix-lite.inputs.nixpkgs.follows = "nixpkgs";
        cl-nix-lite.inputs.treefmt-nix.follows = "mac-app-util/treefmt-nix";
      };
    };
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    # Coding-agent orchestration daemon; upstream ships its own flake with
    # a NixOS module. nixpkgs.follows keeps the container building against
    # the same nixpkgs as the shared host store.
    paseo = {
      url = "github:getpaseo/paseo";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { nixpkgs, ... }@inputs:

    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in

    {
      devShells = forAllSystems (system: {
        default = import ./devshell.nix { pkgs = nixpkgs.legacyPackages.${system}; };
      });

      # nixfmt-tree, not bare nixfmt: `nix fmt` passes a directory, and nixfmt
      # deprecates directory args and walks into .direnv's read-only store
      # symlinks. The wrapper is treefmt driving nixfmt, and respects gitignore.
      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt-tree);

      packages = forAllSystems (system: import ./packages { pkgs = nixpkgs.legacyPackages.${system}; });

      # All five NixOS hosts are x86_64-linux, and the darwin config evaluates
      # here too, so the whole check set lives under this one system.
      checks.x86_64-linux = import ./checks {
        inherit nixpkgs inputs;
        pkgs = nixpkgs.legacyPackages.x86_64-linux;
      };

      darwinConfigurations = {
        mac = inputs.nix-darwin.lib.darwinSystem {
          specialArgs = {
            inherit inputs;
          };
          modules = [ ./hosts/mac ];
        };
      };

      nixosConfigurations = {
        elitebook = nixpkgs.lib.nixosSystem {
          specialArgs = {
            inherit inputs;
          };
          modules = [ ./hosts/elitebook ];
        };
        redtruck = nixpkgs.lib.nixosSystem {
          specialArgs = {
            inherit inputs;
          };
          modules = [ ./hosts/redtruck ];
        };
        t495 = nixpkgs.lib.nixosSystem {
          specialArgs = {
            inherit inputs;
          };
          modules = [ ./hosts/t495 ];
        };
        paynefield = nixpkgs.lib.nixosSystem {
          specialArgs = {
            inherit inputs;
          };
          modules = [ ./hosts/paynefield ];
        };
        vps = nixpkgs.lib.nixosSystem {
          specialArgs = {
            inherit inputs;
          };
          modules = [ ./hosts/vps ];
        };
      };
    };
}
