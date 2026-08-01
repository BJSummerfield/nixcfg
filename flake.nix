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
  };

  outputs = { nixpkgs, ... }@inputs:

    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in

    {
      devShells = forAllSystems (system:
        let pkgs = nixpkgs.legacyPackages.${system};
        in {
          default = pkgs.mkShell {
            packages = with pkgs; [
              sops
            ];
          };
        });

      packages = forAllSystems (system:
        let
          # Own instantiation instead of legacyPackages: the image bakes in
          # claude-code, which is unfree.
          pkgs = import nixpkgs {
            inherit system;
            config.allowUnfreePredicate = pkg:
              builtins.elem (nixpkgs.lib.getName pkg) [ "claude-code" ];
          };
        in
        nixpkgs.lib.optionalAttrs pkgs.stdenv.isLinux {
          # OCI image for running the coding agents on docker-based hosts (macOS).
          coding-agents-image = import ./modules/coding-agents/image.nix { inherit pkgs; };
        });

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
        # vm-mac = nixpkgs.lib.nixosSystem {
        #   specialArgs = {
        #     inherit inputs;
        #   };
        #   modules = [ ./hosts/vm-mac ];
        # };
        vps = nixpkgs.lib.nixosSystem {
          specialArgs = {
            inherit inputs;
          };
          modules = [ ./hosts/vps ];
        };
      };
    };
}
