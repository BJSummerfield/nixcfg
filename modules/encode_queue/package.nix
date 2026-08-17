{ rustPlatform, fetchFromGitHub, ... }:
rustPlatform.buildRustPackage {
  # Fixes a build warning in nixos
  pname = "encode_queue";
  version = "unstable";
  src = fetchFromGitHub {
    owner = "BJSummerfield";
    repo = "encode_queue";
    rev = "a15d41a8ef1c1a0c21a9a6555b4183ec372289fe";
    sha256 = "sha256-jUDG5pjkWHTWOoyV7f6Bdmel8ZzNX1VtG9ZXRD709Kc=";
  };
  cargoHash = "sha256-3hfXLgVzT088UAMfxE7ao86nO7Gx8MHwi+9rLBrYYQw=";
  meta = {
    description = "My custom encode queue tool";
    homepage = "https://github.com/BJSummerfield/encode_queue";
    mainProgram = "encode_queue";
  };
}
