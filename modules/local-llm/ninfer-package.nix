# NInfer ships no releases, no tags and no binaries: upstream's own instruction
# is to build a commit from source. The pin is therefore the version. Bump it
# deliberately - the engine is under daily development.
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
# nvcc 13.1 hosts on GCC 15 and links its libstdc++; the default GCC 16 headers
# emit atomic-wait symbols that library lacks (XGrammar semaphores).
cudaPackages_13_1.backendStdenv.mkDerivation {
  pname = "ninfer";
  version = "0-unstable-2026-10-29";

  src = fetchFromGitHub {
    owner = "Neroued";
    repo = "ninfer";
    rev = "1882c6adbc98043fcf89f3589aa5addb3742777a";
    hash = "sha256-4B71rfuSD9BG8UDs6c+u+H9qnx2fiSnqyWQGTyptsy0=";
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

  # CMakeLists.txt hard-rejects any architecture other than 120a, and the
  # nixpkgs CUDA hooks would otherwise pass the "12.0" spelling.
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

  # Upstream has no install target, by design ("run NInfer from its source
  # build tree"), so the product binaries and their shared libraries are
  # installed by hand.
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
