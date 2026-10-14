{ pkgs }:

# 1Password GUI: nixpkgs' pinned tarball hash drifts from the upstream release,
# so this package fetches the pinned version with its verified hash instead.
pkgs._1password-gui.overrideAttrs {
  src = pkgs.fetchurl {
    url = "https://downloads.1password.com/linux/tar/stable/x86_64/1password-8.12.21.x64.tar.gz";
    hash = "sha256-JwiMi2iozP6jWSIUtgXla86aSAhuUob7snqtUbeXPpI=";
  };
}
