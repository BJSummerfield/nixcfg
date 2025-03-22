{ buildGoModule, fetchFromGitHub }:
buildGoModule {
  pname = "mpls";
  version = "unstable";

  src = fetchFromGitHub {
    owner = "mhersson";
    repo = "mpls";
    rev = "main";
    hash = "sha256-NiNWyR1qmNj5IsFh1gZEBiXBTN7k6R6zkB1HULYKisI=";
  };

  vendorHash = "sha256-xILlYrwcnMWAPACeELwVKGUBIK9QbrUSR03xVmNXsnE=";

  meta = {
    description = "Markdown preview language server";
    homepage = "https://github.com/mhersson/mpls";
    mainProgram = "mpls";
  };
}
