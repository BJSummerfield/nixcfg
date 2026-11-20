{
  nixpkgs,
  inputs,
  pkgs,
}:
let
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
  lintSrc = pkgs.lib.cleanSource ../.;
  hwConfigGlob = "hosts/*/hardware-configuration.nix";

  valheimNotify = pkgs.callPackage ../modules/valheim-server/notify-package.nix { };
  valheimUpdater = pkgs.callPackage ../modules/valheim-server/updater-package.nix {
    inherit (pkgs) systemd;
  };

in
nixpkgs.lib.foldl (a: b: a // b) { } [
  (evalAll "nixos" inputs.self.nixosConfigurations)
  (evalAll "darwin" inputs.self.darwinConfigurations)
  {
    fmt-check =
      pkgs.runCommand "fmt-check"
        {
          nativeBuildInputs = [
            inputs.self.formatter.x86_64-linux
            pkgs.git
          ];
        }
        ''
          cp -r --no-preserve=mode ${lintSrc} src
          cd src
          git init -q
          git add -Af
          treefmt --fail-on-change --no-cache
          touch $out
        '';
    statix-check =
      pkgs.runCommand "statix-check"
        {
          nativeBuildInputs = [ pkgs.statix ];
        }
        ''
          cd ${lintSrc}
          statix check .
          touch $out
        '';
    deadnix-check =
      pkgs.runCommand "deadnix-check"
        {
          nativeBuildInputs = [ pkgs.deadnix ];
        }
        ''
          cd ${lintSrc}
          deadnix --fail . --exclude ${hwConfigGlob}
          touch $out
        '';
    shell-scripts = pkgs.linkFarm "shell-scripts" [
      {
        name = "valheim-notify";
        path = valheimNotify;
      }
      {
        name = "valheim-updater";
        path = valheimUpdater;
      }
    ];
  }
  (nixpkgs.lib.mapAttrs' (
    name: drv: nixpkgs.lib.nameValuePair "pkg-${name}" drv
  ) inputs.self.packages.x86_64-linux)
]
