{
  rustPlatform,
  fetchFromGitHub,
  ...
}:
rustPlatform.buildRustPackage {
  pname = "photoform";
  version = "unstable";
  src = fetchFromGitHub {
    owner = "BJSummerfield";
    repo = "Sheet-Automation-FF";
    rev = "306b3a8f25f2d48c2953af7879f2f63090c83a0d";
    sha256 = "sha256-goPjgkUrh/fGjb//G4JJlV/FjgywGeenhDqv35nPU9k=";
    # Routes the fetch through api.github.com with a netrc built from
    # NIX_GITHUB_PRIVATE_USERNAME/PASSWORD in the nix-daemon environment.
    private = true;
  };
  # cargoHash, never cargoLock.lockFile: reading the lock file out of src is
  # import-from-derivation, so evaluation would fetch the private source and
  # every evaluator would need the GitHub credential.
  cargoHash = "sha256-o+gXWxaFNaJE27NmBxifngkJ2SPdIvYjlHtVvCJOCoU=";
  # Opt in to the binary cache: vps has 1 GB of RAM and cannot compile this.
  passthru.cache = true;
  meta = {
    description = "PhotoForm booking web service";
    mainProgram = "nesting-box-booking";
  };
}
