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
    # Trampoline bundles so Spotlight can index nix-installed apps (it refuses
    # to follow the symlinks home-manager makes).
    mac-app-util = {
      url = "github:hraban/mac-app-util";
      # collapse its transitive pins onto ours so hosts don't fetch the extra
      # nixpkgs snapshots it would otherwise pull
      inputs = {
        nixpkgs.follows = "nixpkgs";
        treefmt-nix.inputs.nixpkgs.follows = "nixpkgs";
        cl-nix-lite.inputs.nixpkgs.follows = "nixpkgs";
        cl-nix-lite.inputs.treefmt-nix.follows = "mac-app-util/treefmt-nix";
      };
    };
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    # Coding-agent orchestration daemon; nixpkgs.follows keeps the container
    # building against the same nixpkgs as the shared host store.
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

      # nixfmt-tree, not bare nixfmt: it is treefmt driving nixfmt, respects
      # gitignore, and doesn't walk into .direnv's read-only store symlinks.
      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt-tree);

      # Set `passthru.cache = true` on a package to have CI push it to the
      # private binary cache as well.
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

      # Eval-only: the work is forcing the eval; nothing is built. Under
      # x86_64-linux because all five NixOS hosts are x86_64 (the darwin
      # config evaluates here too); generated, so a host added later is
      # checked automatically.
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
          photoform = import ./tests/photoform.nix {
            inherit nixpkgs inputs;
            system = "x86_64-linux";
          };
        }
        # Real builds — but `nix flake check` skips any check whose output a
        # substituter already has, so an unchanged package costs nothing.
        # Module-internal derivations (callPackages that never become a flake
        # output) stay structurally outside this set.
        // nixpkgs.lib.mapAttrs' (
          name: drv: nixpkgs.lib.nameValuePair "pkg-${name}" drv
        ) inputs.self.packages.x86_64-linux
        # The eval-only host checks never render a Caddyfile, so a Caddyfile
        # syntax error would first surface on a deploy. Running the real
        # binary's adapter over every caddy host's config makes it a CI
        # failure instead. Generated, so a second caddy host is covered
        # the moment it enables the module.
        //
          nixpkgs.lib.mapAttrs'
            (
              name: cfg:
              nixpkgs.lib.nameValuePair "caddyfile-${name}" (
                pkgs.runCommand "caddyfile-${name}"
                  {
                    nativeBuildInputs = [ cfg.config.services.caddy.package ];
                  }
                  ''
                    HOME=$TMPDIR caddy adapt \
                      --config ${cfg.config.services.caddy.configFile} \
                      --adapter caddyfile > $out
                  ''
              )
            )
            (
              nixpkgs.lib.filterAttrs (_: cfg: cfg.config.services.caddy.enable) inputs.self.nixosConfigurations
            );

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
