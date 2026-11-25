{
  lib,
  fetchFromGitHub,
  cmake,
  ninja,
  pkg-config,
  cudaPackages_13_1,
  autoAddDriverRunpath,
  ffmpeg,
  curl,
  hwloc,
  liburing,
  libjpeg,
  python3,
}:
cudaPackages_13_1.backendStdenv.mkDerivation {
  pname = "ninfer";
  version = "0-unstable-2026-11-24";

  src = fetchFromGitHub {
    owner = "Neroued";
    repo = "ninfer";
    rev = "9ebb72ed756ecbec5dbc18ee22d58fc08575e129";
    hash = "sha256-pJYoDZX/X/yUwuHpRLsfk25SJw79a4Pk+PI8K2qU3uY=";
  };

  nativeBuildInputs = [
    cmake
    ninja
    pkg-config
    cudaPackages_13_1.cuda_nvcc
    autoAddDriverRunpath
    python3
  ];

  buildInputs = [
    cudaPackages_13_1.cuda_cudart
    cudaPackages_13_1.cccl
    cudaPackages_13_1.cuda_nvtx
    cudaPackages_13_1.cuda_profiler_api
    curl
    ffmpeg
    hwloc
    liburing
    libjpeg
  ];

  cmakeFlags = [
    (lib.cmakeFeature "CMAKE_CUDA_ARCHITECTURES" "120a")
    (lib.cmakeBool "NINFER_BUILD_APPS" true)
    (lib.cmakeBool "BUILD_TESTING" true)
    (lib.cmakeBool "NINFER_BUILD_BENCHMARKS" false)
  ];

  ninjaFlags = [
    "ninfer"
    "ninfer-serve"
    "ninfer_resource_manager_test"
    "ninfer_context_pool_test"
    "ninfer_serve_options_test"
  ];

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    LD_LIBRARY_PATH="${cudaPackages_13_1.cuda_cudart}/lib/stubs" \
      ctest --output-on-failure --no-tests=error -R "^ninfer_(resource_manager|context_pool|serve_options)_test$"
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 apps/ninfer apps/ninfer-serve -t "$out/bin"
    mkdir -p "$out/lib"
    cp -P lib/*.so* "$out/lib/"
    for f in "$out"/bin/* "$out"/lib/*.so*; do
      [ -L "$f" ] || patchelf --add-rpath "$out/lib" "$f"
    done
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
