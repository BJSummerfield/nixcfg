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
  # any): a join followed by a real death and respawn, two join-artifact
  # 0:0s that must never fire (Sir Tiny Hog, and Sassy Wench's delayed
  # artifact 21s after her join), an interleaved second and third join, a
  # version-mismatch failed join, a character ZDOID id_hi change across a
  # respawn that must not be mistaken for a return (Andrew Omega's second
  # 0:0), and leaves. Hand-traced against the death guards in notify.sh;
  # see /tmp/valheim-death-plan.md for the derivation.
  valheimNotifySample = pkgs.writeText "valheim-notify-sample.txt" ''
    09/10/2026 20:00:02: Player history entry with index 0:  infestedmrt (Steam_76561198044411510, 4C8BF26B49A14417)
    09/10/2026 20:00:05: Valheim version: l-1.0.12 (network version 40)
    09/10/2026 20:00:30: Game server connected
    09/10/2026 20:06:40: Got connection SteamID 76561198044411510
    09/10/2026 20:06:41: Network version check, their:40, mine:40
    09/10/2026 20:06:51: Got character ZDOID from TeChNo ViKiNg : 2248402172:1
    09/10/2026 20:41:27: Got character ZDOID from TeChNo ViKiNg : 0:0
    09/10/2026 20:41:35: Got character ZDOID from TeChNo ViKiNg : 2248402172:8811
    09/10/2026 21:38:30: Got connection SteamID 76561198000000002
    09/10/2026 21:38:35: Got character ZDOID from Sir Tiny Hog : -203532478:1
    09/10/2026 21:38:39: Got character ZDOID from Sir Tiny Hog : 0:0
    09/10/2026 21:38:41: Got character ZDOID from Sir Tiny Hog : -203532478:3
    09/10/2026 21:43:50: Got connection SteamID 76561198000000003
    09/10/2026 21:43:56: Got character ZDOID from Sassy Wench : 2250297083:1
    09/10/2026 21:44:17: Got character ZDOID from Sassy Wench : 0:0
    09/10/2026 21:44:22: Got character ZDOID from Sassy Wench : 2250297083:12
    09/10/2026 22:03:44: Got connection SteamID 76561198000000004
    09/10/2026 22:03:53: Got character ZDOID from TeChNo ViKiNg : 0:0
    09/10/2026 22:04:01: Got character ZDOID from TeChNo ViKiNg : 2248402172:11667
    09/10/2026 22:04:16: Got character ZDOID from Sir Tiny Hog : 0:0
    09/10/2026 22:04:24: Got character ZDOID from Sir Tiny Hog : -203532478:1851
    09/10/2026 22:04:30: Got character ZDOID from Andrew Omega : -569275172:1
    09/10/2026 22:04:33: Got character ZDOID from Andrew Omega : 0:0
    09/10/2026 22:04:34: Got character ZDOID from Andrew Omega : -569275172:3
    09/10/2026 22:30:00: Got character ZDOID from Sassy Wench : 0:0
    09/10/2026 22:30:08: Got character ZDOID from Sassy Wench : 2250297083:40
    09/10/2026 22:40:00: Got character ZDOID from Sassy Wench : 0:0
    09/10/2026 22:40:45: Got character ZDOID from Sassy Wench : 2250297083:5000
    09/10/2026 22:45:00: Got character ZDOID from Andrew Omega : 0:0
    09/10/2026 22:45:05: Got character ZDOID from Andrew Omega : 1111111111:5000
    09/10/2026 22:50:00: Got connection SteamID 76561190000000001
    09/10/2026 22:50:05: Network version check, their:39, mine:40
    09/10/2026 22:50:06: Closing socket 76561190000000001
    09/10/2026 23:00:00: Got character ZDOID from Andrew Omega : 0:0
    09/10/2026 23:00:03: Closing socket 76561198000000004
    09/10/2026 23:00:04: Got connection SteamID 76561198000000004
    09/10/2026 23:00:10: Got character ZDOID from Andrew Omega : 1111111111:5000
    09/10/2026 23:50:00: Got connection SteamID 76561198000000005
    09/10/2026 23:50:10: Got character ZDOID from Drowrof : -578924324:1
    09/11/2026 00:10:33: Got character ZDOID from Drowrof : 0:0
    09/11/2026 00:10:41: Got character ZDOID from Drowrof : -578924324:11412
    09/11/2026 00:20:00: Got character ZDOID from Sir Tiny Hog : 0:0
    09/11/2026 00:20:04: Closing socket 76561198000000002
    09/11/2026 00:30:00: Closing socket 76561198044411510
  '';

  valheimNotifyExpected = pkgs.writeText "valheim-notify-expected.txt" ''
    up l-1.0.12
    join 76561198044411510 TeChNo ViKiNg (1 online)
    death TeChNo ViKiNg
    join 76561198000000002 Sir Tiny Hog (2 online)
    join 76561198000000003 Sassy Wench (3 online)
    death TeChNo ViKiNg
    death Sir Tiny Hog
    join 76561198000000004 Andrew Omega (4 online)
    mismatch 39 40
    leave 76561198000000004 Andrew Omega (3 online)
    join 76561198000000004 Andrew Omega (4 online)
    join 76561198000000005 Drowrof (5 online)
    death Drowrof
    leave 76561198000000002 Sir Tiny Hog (4 online)
    leave 76561198044411510 TeChNo ViKiNg (3 online)
  '';

  # Fixture for valheim-notify-death-message: a comment and a blank line to
  # be skipped, then three usable templates exercising escaping (an
  # ampersand, backslash and command-substitution-shaped text in the name;
  # a name with `_` that must not be bolded) and index wraparound.
  valheimDeathLinesFixture = pkgs.writeText "valheim-death-lines-fixture.txt" ''
    # comment is skipped

    {player} fell off a cliff 😬
    Odin shrugs at {player} & moves on
    Hugin reports {player} \1 $(nope)
  '';

  valheimDeathMessageExpected = pkgs.writeText "valheim-death-message-expected.txt" ''
    💀 *Sir Tiny Hog* fell off a cliff 😬
    💀 Odin shrugs at *a&b\1 $(x)* & moves on
    💀 Hugin reports under_score \1 $(nope)
    💀 *Drowrof* fell off a cliff 😬
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
  valheim-notify-death-message =
    pkgs.runCommand "valheim-notify-death-message"
      {
        nativeBuildInputs = [ valheimNotify ];
        VALHEIM_DEATH_LINES = valheimDeathLinesFixture;
      }
      ''
        {
          valheim-notify death-message 0 'Sir Tiny Hog'
          valheim-notify death-message 1 'a&b\1 $(x)'
          valheim-notify death-message 2 'under_score'
          valheim-notify death-message 3 'Drowrof'
        } >actual
        diff -u ${valheimDeathMessageExpected} actual
        touch $out
      '';
  valheim-death-lines = pkgs.runCommand "valheim-death-lines" { } ''
    lines=${../modules/valheim-server/death-lines.txt}
    content=$(grep -Ev '^[[:space:]]*(#.*)?$' "$lines" || true)
    count=$(printf '%s\n' "$content" | grep -c . || true)
    if [ "$count" -lt 100 ]; then
      echo "expected at least 100 usable lines, got $count" >&2
      exit 1
    fi
    bad=$(printf '%s\n' "$content" | awk -F'[{]player[}]' 'NF != 2')
    if [ -n "$bad" ]; then
      echo "lines without exactly one {player}:" >&2
      echo "$bad" >&2
      exit 1
    fi
    bad=$(printf '%s\n' "$content" | grep -E '^💀|[*_~`]' || true)
    if [ -n "$bad" ]; then
      echo "lines with a leading skull or markdown/backtick characters:" >&2
      echo "$bad" >&2
      exit 1
    fi
    bad=$(printf '%s\n' "$content" | grep -E '^[[:space:]]|[[:space:]]$' || true)
    if [ -n "$bad" ]; then
      echo "lines with leading or trailing whitespace:" >&2
      echo "$bad" >&2
      exit 1
    fi
    dupes=$(printf '%s\n' "$content" | sort | uniq -d)
    if [ -n "$dupes" ]; then
      echo "duplicate lines:" >&2
      echo "$dupes" >&2
      exit 1
    fi
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
