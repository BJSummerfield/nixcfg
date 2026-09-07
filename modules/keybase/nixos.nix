# nixpkgs marks keybase-gui 6.5.1 insecure (Electron 28, EOL since 2023-12).
# Upstream fixed it in 6.6.3 (Electron 44) and nixpkgs PR #497751 has the bump
# approved but unmerged since 2026-03-08, so carry it here until it lands:
# https://github.com/NixOS/nixpkgs/pull/497751
#
# Delete this file when `nix eval nixpkgs#keybase-gui.version` reports 6.6.3 or
# later. The warning below fires on the next rebuild after that happens - the
# overlay pins unconditionally, so without it a newer nixpkgs would be silently
# rolled back to 6.6.3.
{ lib, ... }:
let
  version = "6.6.3";
in
{
  nixpkgs.overlays = [
    (_final: prev: {
      keybase = prev.keybase.overrideAttrs (old: {
        inherit version;
        src = old.src.override {
          tag = "v";
          hash = "sha256-TRDJINzuObgn6JWZ9CoHWxKO23I9sceDlB4MmnqlOvw=";
        };
        vendorHash = "sha256-OGavtp0vYqK0D4P+ypVyEF8GsvDvfIDQXsjlKmpKJJ4=";
      });

      keybase-gui =
        lib.warnIf (lib.versionAtLeast prev.keybase-gui.version version)
          "modules/keybase/nixos.nix: nixpkgs now has keybase-gui ${prev.keybase-gui.version}; delete this overlay"
          (
            prev.keybase-gui.overrideAttrs (old: {
              inherit version;
              src = prev.fetchurl {
                url = "https://s3.amazonaws.com/prerelease.keybase.io/linux_binaries/deb/keybase_${version}-20260603142455.f60f2ff97e_amd64.deb";
                hash = "sha256-4OqjEc2kLJpJ7FC7WR0DAfsmsrvoKHrm4RtBdGpkti4=";
              };
              meta = old.meta // {
                knownVulnerabilities = [ ];
              };
            })
          );
    })
  ];
}
