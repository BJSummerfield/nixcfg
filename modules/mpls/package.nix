{ fetchFromGitHub, buildGoModule, ... }:
buildGoModule {
  pname = "mpls";
  version = "unstable";
  src = fetchFromGitHub {
    owner = "mhersson";
    repo = "mpls";
    rev = "main";
    hash = "sha256-ChEZigLKzU/SILcJoyjKZI1qqrAi9qA6ugUeg5AL2Mw=";
  };
  vendorHash = "sha256-n3DG3sR7HOQPQJW1t1qC94EKkDBgXpdmjUWtLzAE7kY=";
  meta = {
    description = "Markdown preview language server";
    homepage = "https://github.com/mhersson/mpls";
    mainProgram = "mpls";
  };
}
