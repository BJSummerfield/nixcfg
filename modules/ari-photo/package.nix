{ rustPlatform, fetchFromGitHub, ... }:
rustPlatform.buildRustPackage {
  pname = "ari_photo";
  version = "unstable";
  src = fetchFromGitHub {
    owner = "BJSummerfield";
    repo = "ari_photo";
    rev = "cd3c6507c4f249f9e747d4ee8ab58120add59fc2";
    sha256 = "sha256-lONdUSGOVz2RHpPxsqYNUzP/pjgYXzWC3FjxrU2UMBg=";
    private = true;
  };
  cargoHash = "sha256-z8gaRibuHuwhsJoj5YGhZgRRlRZWVu3vJgLH+e2MnMU=";
  postInstall = ''
    mkdir -p $out/share/ari_photo
    cp -r photos $out/share/ari_photo/photos
  '';
  passthru.cache = true;
  meta = {
    description = "Ari Summerfield Photography website";
    mainProgram = "ari_photo";
  };
}
