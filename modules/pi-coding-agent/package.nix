{
  lib,
  buildNpmPackage,
  fetchFromGitHub,
  fetchurl,
  nix-update-script,
  versionCheckHook,
  writableTmpDirAsHomeHook,
  ripgrep,
  fd,
  makeBinaryWrapper,
}:
buildNpmPackage (finalAttrs: {
  pname = "pi-coding-agent";
  version = "1.6.0";

  src = fetchFromGitHub {
    owner = "earendil-works";
    repo = "pi";
    tag = "v${finalAttrs.version}";
    hash = "sha256-UVQnOMYikjxi7JREcxPZh/Uamy0l4rBvhawHR/MZZgo=";
  };

  npmDepsHash = "sha256-V7fRy44X50tqfFewWQ/k5UjvUt+AoMOZkTw/v0bib6o=";

  modelData = fetchurl {
    url = "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-${finalAttrs.version}.tgz";
    hash = "sha256-1oMS7FdLyVnLf+4m2k9IdtBnrtm7vnbodjWeYNIpR0c=";
  };

  preConfigure = ''
    mkdir -p packages/ai/src/providers/data
    tar --extract --gzip --file=${finalAttrs.modelData} \
      --directory=packages/ai/src/providers/data \
      --strip-components=4 \
      package/dist/providers/data
  '';

  npmWorkspace = "packages/coding-agent";

  npmRebuildFlags = [ "--ignore-scripts" ];

  nativeBuildInputs = [
    makeBinaryWrapper
  ];

  buildPhase = ''
    runHook preBuild

    npm run build:offline

    runHook postBuild
  '';

  dontNpmPrune = true;

  preInstall = ''
    npm prune --omit=dev --no-save
  '';

  postInstall = ''
    local nm="$out/lib/node_modules/pi-monorepo/node_modules"

    for ws in @earendil-works/pi-ai:packages/ai \
              @earendil-works/pi-agent-core:packages/agent \
              @earendil-works/pi-codemode:packages/codemode \
              @earendil-works/pi-mcp:packages/mcp \
              @earendil-works/pi-schema:packages/schema \
              @earendil-works/pi-telemetry:packages/telemetry \
              @earendil-works/pi-tui:packages/tui; do
      IFS=: read -r pkg src <<< "$ws"
      rm "$nm/$pkg"
      cp -r "$src" "$nm/$pkg"
    done

    find "$nm" -xtype l -delete
  '';

  postFixup = ''
    wrapProgram $out/bin/pi --prefix PATH : ${
      lib.makeBinPath [
        ripgrep
        fd
      ]
    } \
      --set-default PI_SKIP_VERSION_CHECK 1 \
      --set-default PI_TELEMETRY 0
  '';

  doInstallCheck = true;
  nativeInstallCheckInputs = [
    writableTmpDirAsHomeHook
    versionCheckHook
  ];
  versionCheckKeepEnvironment = [ "HOME" ];
  versionCheckProgram = "${placeholder "out"}/bin/pi";
  versionCheckProgramArg = "--version";

  passthru.updateScript = nix-update-script {
    extraArgs = [
      "--custom-dep"
      "modelData"
    ];
  };

  meta = {
    description = "Coding agent CLI with read, bash, edit, write tools and session management";
    homepage = "https://pi.dev/";
    downloadPage = "https://www.npmjs.com/package/@earendil-works/pi-coding-agent";
    changelog = "https://github.com/earendil-works/pi/blob/v${finalAttrs.version}/packages/coding-agent/CHANGELOG.md";
    license = lib.licenses.mit;
    maintainers = with lib.maintainers; [
      munksgaard
      bryanhonof
    ];
    mainProgram = "pi";
  };
})
