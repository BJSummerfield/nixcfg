{ rustPlatform, fetchFromGitHub, ... }:
rustPlatform.buildRustPackage {
  pname = "switchyard";
  version = "unstable";
  src = fetchFromGitHub {
    owner = "BJSummerfield";
    repo = "switchyard";
    rev = "448800444d0a0f288b23123219a6aa84de25b461";
    sha256 = "sha256-dnDH38+c9deOwFh/OLY3kQIAwDGnGgD3hxrYO3mVQ/4=";
    private = true;
  };
  cargoHash = "sha256-y0Y8qj2/KbGrj9z7X70cgSsSSlZN7aHL+h7UYHzdZXk=";
  passthru.cache = true;
  meta = {
    description = "Order taking and pickup tracking for a small event kitchen";
    mainProgram = "switchyard";
  };
}
