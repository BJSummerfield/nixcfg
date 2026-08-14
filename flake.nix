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
      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nixfmt
              sops
            ];
          };
        }
      );

      # nixfmt-tree, not bare nixfmt: `nix fmt` passes a directory, and nixfmt
      # deprecates directory args and walks into .direnv's read-only store
      # symlinks. The wrapper is treefmt driving nixfmt, and respects gitignore.
      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt-tree);

      # Evaluation-only. `nix flake check` builds nothing here beyond two empty
      # marker derivations; the work is in forcing the eval. Scoped to
      # x86_64-linux rather than forAllSystems because both the test host and
      # redtruck are x86_64-linux, and evaluating a NixOS host under a darwin
      # hostPlatform would fail for reasons unrelated to what is tested.
      checks.x86_64-linux = {
        devboxes = import ./tests/devboxes.nix {
          inherit nixpkgs inputs;
          system = "x86_64-linux";
        };

        # Guards the real host against a refactor that only breaks in
        # combination with the rest of its module set. drvPath forces a full
        # evaluation without building anything.
        redtruck-eval =
          builtins.seq inputs.self.nixosConfigurations.redtruck.config.system.build.toplevel.drvPath
            (nixpkgs.legacyPackages.x86_64-linux.runCommand "redtruck-eval" { } "touch $out");
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
