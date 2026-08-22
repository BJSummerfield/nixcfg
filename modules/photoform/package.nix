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
    rev = "352b89a69ccfadb9dff1a39411a6d2ebebb46417";
    sha256 = "sha256-wvRkCqGedGIOkMqFcB3Q9C7n1ZVfp4AVF8DkQBpCAl0=";
    # Routes the fetch through api.github.com with a netrc built from
    # NIX_GITHUB_PRIVATE_USERNAME/PASSWORD in the nix-daemon environment.
    private = true;
  };
  # cargoHash, never cargoLock.lockFile: reading the lock file out of src is
  # import-from-derivation, so evaluation would fetch the private source and
  # every evaluator would need the GitHub credential.
  cargoHash = "sha256-o+gXWxaFNaJE27NmBxifngkJ2SPdIvYjlHtVvCJOCoU=";
  # cargo installs the binary and nothing else; the module names this file
  # through BOOKING_CONFIG.
  postInstall = ''
    install -Dm444 config/production.toml $out/share/photoform/production.toml
  '';
  # Opt in to the binary cache: vps has 1 GB of RAM and cannot compile this.
  passthru.cache = true;
  meta = {
    description = "PhotoForm booking web service";
    mainProgram = "nesting-box-booking";
  };
}
