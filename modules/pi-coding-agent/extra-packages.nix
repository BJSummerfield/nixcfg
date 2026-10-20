pkgs: [
  pkgs.nodejs
  pkgs.bun
  (pkgs.callPackage ../agent-recipes/package.nix { })
]
