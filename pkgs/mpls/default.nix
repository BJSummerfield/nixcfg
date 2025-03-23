{ buildGoModule, fetchFromGitHub }:
buildGoModule {
  pname = "mpls";
  version = "unstable";

  src = fetchFromGitHub {
    owner = "mhersson";
    repo = "mpls";
    rev = "main";
    hash = "sha256-P9IXvCY/E5tPMGT708X/I4SqWV2e7maXv8KVrtv2ggs=";
  };

  vendorHash = "sha256-xILlYrwcnMWAPACeELwVKGUBIK9QbrUSR03xVmNXsnE=";

  meta = {
    description = "Markdown preview language server";
    homepage = "https://github.com/mhersson/mpls";
    mainProgram = "mpls";
  };
}
