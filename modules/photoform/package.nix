{
  rustPlatform,
  fetchFromGitHub,
  ...
}:
let
  # Also named from the module via BOOKING_CONFIG; one source, no drift.
  configPath = "share/photoform/production.toml";
in
rustPlatform.buildRustPackage {
  pname = "photoform";
  version = "unstable";
  src = fetchFromGitHub {
    owner = "BJSummerfield";
    repo = "Sheet-Automation-FF";
    rev = "6e5e011b7faba371c14267f03a2da81b317ed185";
    sha256 = "sha256-z87Ha1hSrjT8f9h3PU+EG1xzrR6BmIzD5hvQMfFRlwk=";
    # Routes the fetch through api.github.com with a netrc built from
    # NIX_GITHUB_PRIVATE_USERNAME/PASSWORD in the nix-daemon environment.
    private = true;
  };
  # cargoHash, never cargoLock.lockFile: reading the lock file out of src is
  # import-from-derivation, so evaluation would fetch the private source and
  # every evaluator would need the GitHub credential.
  cargoHash = "sha256-o+gXWxaFNaJE27NmBxifngkJ2SPdIvYjlHtVvCJOCoU=";
  # cargo installs the binary and nothing else.
  postInstall = ''
    install -Dm444 config/production.toml $out/${configPath}
  '';
  passthru = {
    # Opt in to the binary cache: vps has 1 GB of RAM and cannot compile this.
    cache = true;
    inherit configPath;
  };
  meta = {
    description = "PhotoForm booking web service";
    mainProgram = "nesting-box-booking";
  };
}
