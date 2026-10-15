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
      && [ "$(git config --get core.hooksPath 2>/dev/null)" = ".githooks" ]; then
      git config --local --unset core.hooksPath 2>/dev/null || true
      git config --file "$(git rev-parse --git-common-dir)/config" --unset core.hooksPath 2>/dev/null || true
    fi
  '';
}
