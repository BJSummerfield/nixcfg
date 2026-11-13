{ rustPlatform, fetchFromGitHub, ... }:
rustPlatform.buildRustPackage {
  pname = "switchyard";
  version = "unstable";
  src = fetchFromGitHub {
    owner = "BJSummerfield";
    repo = "switchyard";
    rev = "b3bc6a4ef12b4edf94e4ea6cce3672edb4e95c3e";
    sha256 = "sha256-2Es+m1B8VGKx3CgAqPClPb2tMGtz1Fq7DCT76+DvlDc=";
    private = true;
  };
  cargoHash = "sha256-y0Y8qj2/KbGrj9z7X70cgSsSSlZN7aHL+h7UYHzdZXk=";
  passthru.cache = true;
  meta = {
    description = "Order taking and pickup tracking for a small event kitchen";
    mainProgram = "switchyard";
  };
}
