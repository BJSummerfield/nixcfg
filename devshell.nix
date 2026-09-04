{ pkgs }:
pkgs.mkShell {
  packages = with pkgs; [
    nixfmt
    sops
    statix
    deadnix
  ];
}
