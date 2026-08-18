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

      # Exposed so `nix build .#encode_queue` works and so the checks below
      # build it. bicep-langserver is deliberately absent: no host enables it
      # and its dotnet SDK dependency is a 712 MiB closure.
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          encode_queue = pkgs.callPackage ./modules/encode_queue/package.nix { };
          photoform = pkgs.callPackage ./modules/photoform/package.nix { };
        }
      );

      # Evaluation-only. `nix flake check` builds nothing beyond one empty
      # marker derivation per configuration (devboxes likewise only touches
      # $out on success); the work is forcing the eval. Everything lives
      # under x86_64-linux because all five NixOS hosts are x86_64-linux and
      # the darwin config evaluates here too. Generated rather than listed so
      # a host added later is checked automatically.
      checks.x86_64-linux =
        let
          pkgs = nixpkgs.legacyPackages.x86_64-linux;
          evalOnly = name: drvPath: builtins.seq drvPath (pkgs.runCommand "eval-${name}" { } "touch $out");
          evalAll =
            prefix:
            nixpkgs.lib.mapAttrs' (
              name: cfg:
              let
                checkName = "${prefix}-${name}";
              in
              nixpkgs.lib.nameValuePair checkName (evalOnly checkName cfg.config.system.build.toplevel.drvPath)
            );
        in
        evalAll "nixos" inputs.self.nixosConfigurations
        // evalAll "darwin" inputs.self.darwinConfigurations
        // {
          devboxes = import ./tests/devboxes.nix {
            inherit nixpkgs inputs;
            system = "x86_64-linux";
          };
        }
        # Unlike the eval-only checks above, these really build. A package
        # added later to `packages` is covered without anyone wiring it up —
        # but derivations defined inside modules (callPackages that never
        # become a flake output) are structurally outside this set and stay
        # uncovered.
        // nixpkgs.lib.mapAttrs' (
          name: drv: nixpkgs.lib.nameValuePair "pkg-${name}" drv
        ) inputs.self.packages.x86_64-linux;

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
