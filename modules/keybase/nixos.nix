# nixpkgs marked keybase-gui 6.5.1 insecure (EOL Electron 28). Pin both
# keybase and keybase-gui to 6.6.3 via nixpkgs PR #497751 until it merges:
# https://github.com/NixOS/nixpkgs/pull/497751
_: {
  nixpkgs.overlays = [
    (final: _prev: {
      keybase-gui = final.callPackage ./pkgs/keybase-gui.nix { };
      keybase = final.callPackage ./pkgs/keybase.nix { };
    })
  ];
}
