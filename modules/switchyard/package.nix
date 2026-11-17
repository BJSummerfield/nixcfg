{
  rustPlatform,
  fetchFromGitHub,
  pkg-config,
  sqlite,
  ...
}:
rustPlatform.buildRustPackage {
  pname = "switchyard";
  version = "unstable";
  src = fetchFromGitHub {
    owner = "BJSummerfield";
    repo = "switchyard";
    rev = "baab92ff545f825f60e28b9438ae036f9d05d09a";
    sha256 = "sha256-et4+uC/2OvcFy2czSMQBm4q5rzuk6FJiPh3I7YzIdF0=";
    private = true;
  };
  cargoHash = "sha256-y0Y8qj2/KbGrj9z7X70cgSsSSlZN7aHL+h7UYHzdZXk=";
  nativeBuildInputs = [ pkg-config ];
  buildInputs = [ sqlite ];
  passthru.cache = true;
  meta = {
    description = "Order taking and pickup tracking for a small event kitchen";
    mainProgram = "switchyard";
  };
}
