{
  rustPlatform,
  fetchFromGitHub,
  lib,
  ...
}:
rustPlatform.buildRustPackage {
  pname = "photoform";
  version = "unstable";
  src = fetchFromGitHub {
    owner = "BJSummerfield";
    repo = "Sheet-Automation-FF";
    rev = "4ed5a58e03b3c1aa5af5ca6ba179802ccdcde27f";
    sha256 = lib.fakeSha256;
    # Routes the fetch through api.github.com with a netrc built from
    # NIX_GITHUB_PRIVATE_USERNAME/PASSWORD in the nix-daemon environment.
    private = true;
  };
  # cargoHash, never cargoLock.lockFile: reading the lock file out of src is
  # import-from-derivation, so evaluation would fetch the private source and
  # every evaluator would need the GitHub credential.
  cargoHash = lib.fakeHash;
  meta = {
    description = "PhotoForm booking web service";
    mainProgram = "nesting-box-booking";
  };
}
