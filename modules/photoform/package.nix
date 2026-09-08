{
  rustPlatform,
  fetchFromGitHub,
  ...
}:
let
  configPath = "share/photoform/production.toml";
in
rustPlatform.buildRustPackage {
  pname = "photoform";
  version = "unstable";
  src = fetchFromGitHub {
    owner = "BJSummerfield";
    repo = "Sheet-Automation-FF";
    rev = "ad78a762f106e7c2e07284a8e5f9371991894a8f";
    sha256 = "sha256-qAI0XDmyDh63keyzwgQBOTbT1CXCp4PtvO445JPh7nw=";
    private = true;
  };
  cargoHash = "sha256-o+gXWxaFNaJE27NmBxifngkJ2SPdIvYjlHtVvCJOCoU=";
  postInstall = ''
    install -Dm444 config/production.toml $out/${configPath}
  '';
  passthru = {
    cache = true;
    inherit configPath;
  };
  meta = {
    description = "PhotoForm booking web service";
    mainProgram = "nesting-box-booking";
  };
}
