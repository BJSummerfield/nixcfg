{ rustPlatform, fetchFromGitHub, ... }:
rustPlatform.buildRustPackage {
  pname = "switchyard";
  version = "unstable";
  src = fetchFromGitHub {
    owner = "BJSummerfield";
    repo = "switchyard";
    rev = "6c54efb699807bf6044c554433c07ba9d248800c";
    sha256 = "sha256-xcyOqAJMyrCT1q41isDFXY35tFImFqZpz75jC32Xbto=";
    private = true;
  };
  cargoHash = "sha256-/uv44TiZg2c9kFC8mkawJaLCGcUig1p++V0zMZSKuKw=";
  passthru.cache = true;
  meta = {
    description = "Order taking and pickup tracking for a small event kitchen";
    mainProgram = "switchyard";
  };
}
