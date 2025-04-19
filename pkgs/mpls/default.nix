{ buildGoModule, fetchFromGitHub }:
buildGoModule {
  pname = "mpls";
  version = "unstable";

  src = fetchFromGitHub {
    owner = "mhersson";
    repo = "mpls";
    rev = "main";
    hash = "sha256-z3miAbL3qQHusWoofUp8kNNZjoGANhPjeIj39KPYyvc=";
  };

  vendorHash = "sha256-xILlYrwcnMWAPACeELwVKGUBIK9QbrUSR03xVmNXsnE=";

  meta = {
    description = "Markdown preview language server";
    homepage = "https://github.com/mhersson/mpls";
    mainProgram = "mpls";
  };
}
