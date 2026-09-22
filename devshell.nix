{ pkgs }:
pkgs.mkShell {
  packages = with pkgs; [
    nixfmt
    sops
    statix
    deadnix
  ];

  shellHook = ''
    if git rev-parse --git-dir >/dev/null 2>&1 \
      && [ "$(git config --get core.hooksPath)" != ".githooks" ]; then
      git config core.hooksPath .githooks
    fi
  '';
}
