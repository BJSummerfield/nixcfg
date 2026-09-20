# NInfer ships no releases, no tags and no binaries: upstream's own instruction
# is to build a commit from source. The pin is therefore the version. Bump it
# deliberately - the engine is under daily development and its context-cache
# bugs (upstream #251, #270, #177, #229) are open at this revision.
{
  lib,
  stdenv,
  fetchFromGitHub,
  cmake,
  ninja,
  pkg-config,
  cudaPackages_13_1,
  autoAddDriverRunpath,
  ffmpeg,
  curl,
}:
stdenv.mkDerivation {
  pname = "ninfer";
  version = "0-unstable-2026-09-18";

  src = fetchFromGitHub {
    owner = "Neroued";
    repo = "ninfer";
    rev = "9e163eee4b8acec21ab0ac765107b6a3f287b217";
    hash = "sha256-RvcHyR6ErYQXoBmqCPqSzP4q5yXOX91+X6TPXp5HAk4=";
  };

  nativeBuildInputs = [
    cmake
    ninja
    pkg-config
    cudaPackages_13_1.cuda_nvcc
    autoAddDriverRunpath
  ];

  buildInputs = [
    cudaPackages_13_1.cuda_cudart
    cudaPackages_13_1.cccl
    cudaPackages_13_1.cuda_nvtx
    curl
    ffmpeg
  ];

  # CMakeLists.txt hard-rejects any architecture other than 120a, and the
  # nixpkgs CUDA hooks would otherwise pass the "12.0" spelling.
  cmakeFlags = [
    (lib.cmakeFeature "CMAKE_CUDA_ARCHITECTURES" "120a")
    (lib.cmakeBool "NINFER_BUILD_APPS" true)
    (lib.cmakeBool "BUILD_TESTING" false)
    (lib.cmakeBool "NINFER_BUILD_BENCHMARKS" false)
  ];

  ninjaFlags = [
    "ninfer"
    "ninfer-serve"
  ];

  # Upstream has no install target, by design ("run NInfer from its source
  # build tree"), so the two product binaries are installed by hand.
  installPhase = ''
    runHook preInstall
    install -Dm755 apps/ninfer apps/ninfer-serve -t "$out/bin"
    runHook postInstall
  '';

  meta = {
    description = "Single-GPU C++/CUDA inference engine for Qwen3.5-architecture checkpoints on an RTX 5090";
    homepage = "https://github.com/Neroued/ninfer";
    license = lib.licenses.asl20;
    mainProgram = "ninfer-serve";
    platforms = [ "x86_64-linux" ];
  };
}
