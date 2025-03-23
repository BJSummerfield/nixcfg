{ rustPlatform, fetchFromGitHub }:

rustPlatform.buildRustPackage {
  #fixes build warning in nixos
  useFetchCargoVendor = true;
  pname = "encode-queue";
  version = "unstable";

  src = fetchFromGitHub {
    owner = "BJSummerfield";
    repo = "encode_queue";
    rev = "main";
    sha256 = "sha256-jUDG5pjkWHTWOoyV7f6Bdmel8ZzNX1VtG9ZXRD709Kc=";

  };
  cargoHash = "sha256-3hfXLgVzT088UAMfxE7ao86nO7Gx8MHwi+9rLBrYYQw=";
}
