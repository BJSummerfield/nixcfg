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

  # No annotations in the lines themselves (systemd journal lines never have
  # any): the base sample from the plan (a join, a death, a respawn, a
  # version-mismatch failed join, a leave), plus a second player who
  # actually joins after the first player's respawn, to prove the "a
  # respawn of an already-joined name is ignored" rule doesn't also
  # swallow a genuine later join.
  valheimNotifySample = pkgs.writeText "valheim-notify-sample.txt" ''
    09/10/2026 21:14:02: Player history entry with index 0:  infestedmrt (Steam_76561198044411510, 4C8BF26B49A14417)
    09/10/2026 21:14:03: Player history entry with index 1:  Bjorn Ironside (Steam_76561198044411999, 5D9CF37C5AB25528)
    09/10/2026 21:14:05: Valheim version: l-1.0.12 (network version 40)
    09/10/2026 21:14:30: Game server connected
    09/10/2026 21:20:00: Got connection SteamID 76561198044411510
    09/10/2026 21:20:01: Network version check, their:40, mine:40
    09/10/2026 21:20:25: Got character ZDOID from TeChNo ViKiNg : 1930526702:19
    09/10/2026 21:24:00: Connections 1 ZDOS:170402  sent:0 recv:0
    09/10/2026 21:30:00: Got character ZDOID from TeChNo ViKiNg : 0:0
    09/10/2026 21:30:10: Got character ZDOID from TeChNo ViKiNg : 1930526702:44
    09/10/2026 21:31:00: Got connection SteamID 76561198044411999
    09/10/2026 21:31:05: Network version check, their:40, mine:40
    09/10/2026 21:31:20: Got character ZDOID from Bjorn Ironside : 2200000000:5
    09/10/2026 21:35:00: Got connection SteamID 76561190000000001
    09/10/2026 21:35:05: Network version check, their:39, mine:40
    09/10/2026 21:35:06: Closing socket 76561190000000001
    09/10/2026 21:36:00: Closing socket 76561198044411999
    09/10/2026 21:40:00: Closing socket 76561198044411510
  '';

  valheimNotifyExpected = pkgs.writeText "valheim-notify-expected.txt" ''
    up l-1.0.12
    join 76561198044411510 TeChNo ViKiNg (1 online)
    join 76561198044411999 Bjorn Ironside (2 online)
    mismatch 39 40
    leave 76561198044411999 Bjorn Ironside (1 online)
    leave 76561198044411510 TeChNo ViKiNg (0 online)
  '';
in
evalAll "nixos" inputs.self.nixosConfigurations
// evalAll "darwin" inputs.self.darwinConfigurations
// {
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
  valheim-notify-parser =
    pkgs.runCommand "valheim-notify-parser"
      {
        nativeBuildInputs = [ valheimNotify ];
      }
      ''
        valheim-notify parse <${valheimNotifySample} >actual
        diff -u ${valheimNotifyExpected} actual
        touch $out
      '';
}
// nixpkgs.lib.mapAttrs' (
  name: drv: nixpkgs.lib.nameValuePair "pkg-${name}" drv
) inputs.self.packages.x86_64-linux
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
    (nixpkgs.lib.filterAttrs (_: cfg: cfg.config.services.caddy.enable) inputs.self.nixosConfigurations)
