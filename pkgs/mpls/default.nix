{ buildGoModule, fetchFromGitHub }:
buildGoModule {
  pname = "mpls";
  version = "unstable";

  src = fetchFromGitHub {
    owner = "mhersson";
    repo = "mpls";
    rev = "main";
    hash = "sha256-cyfVa5tFYHDE0+q7D1Urn50YfzC3mcuNGT3Lc2Su+o4=";
  };

  vendorHash = "sha256-xILlYrwcnMWAPACeELwVKGUBIK9QbrUSR03xVmNXsnE=";

  meta = {
    description = "Markdown preview language server";
    homepage = "https://github.com/mhersson/mpls";
    mainProgram = "mpls";
  };
}
