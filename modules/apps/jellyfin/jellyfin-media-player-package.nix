{ lib
, fetchFromGitHub
, fetchpatch
, stdenv
, SDL2
, cmake
, glibcLocales
, libGL
, libiconv
, libX11
, libXrandr
, libvdpau
, mpv
, ninja
, pkg-config
, python3
, qtbase
, qt5compat
, qtdeclarative
, qtpositioning
, qtwayland
, qtwebchannel
, qtwebengine
, withDbus ? stdenv.hostPlatform.isLinux
,
}:

stdenv.mkDerivation rec {
  pname = "jellyfin-media-player";
  version = "1.12.0-unstable-2025-10-29";

  src = fetchFromGitHub {
    owner = "jellyfin";
    repo = "jellyfin-media-player";
    rev = "67d1298b4c2e4d302bb9f818dd48f1794b4a3aac";
    hash = "sha256-SO4Iyao6Ivdj6QWrUlTVQYPed5/8F30zZlPzX9jPqRE=";
  };

  patches = [
    ./disable-update-notifications.patch
  ];

  buildInputs = [
    SDL2
    libGL
    libX11
    libXrandr
    libvdpau
    mpv
    qtbase
    qt5compat
    qtdeclarative
    qtpositioning
    qtwebchannel
    qtwebengine
    qtwayland
  ];

  nativeBuildInputs = [
    cmake
    ninja
    pkg-config
    python3
  ];

  cmakeFlags = [
    "-DQTROOT=${qtbase}"
    "-GNinja"
  ] ++ lib.optionals (!withDbus) [
    "-DLINUX_X11POWER=ON"
  ];

  dontWrapQtApps = true;

  postInstall = ''
    mv $out/bin/jellyfinmediaplayer $out/bin/.jellyfinmediaplayer-wrapped

    cat > "$out/bin/jellyfinmediaplayer" << 'EOF'
    #!/bin/sh

    # Point to the locale data we bundled with the package
    export LOCALE_ARCHIVE="${glibcLocales}/lib/locale/locale-archive"

    # Force the UTF-8 locale
    export LANG="en_US.UTF-8"
    export LC_ALL="en_US.UTF-8"

    # Manually set all the Qt plugin paths
    export QT_PLUGIN_PATH="${qtbase}/${qtbase.qtPluginPrefix}:${qtwebengine}/${qtbase.qtPluginPrefix}"
    export QT_QPA_PLATFORM_PLUGIN_PATH="${qtbase}/${qtbase.qtPluginPrefix}/platforms"
    export QML2_IMPORT_PATH="${qtbase}/${qtbase.qtQmlPrefix}:${qtdeclarative}/${qtbase.qtQmlPrefix}:${qtwebchannel}/${qtbase.qtQmlPrefix}:${qtwebengine}/${qtbase.qtQmlPrefix}"

    # Also fix the "DisplayManager" error by forcing Wayland
    export QT_QPA_PLATFORM="wayland"

    # Execute the real binary
    exec "$out/bin/.jellyfinmediaplayer-wrapped" "$@"
    EOF

    substituteInPlace "$out/bin/jellyfinmediaplayer" \
      --replace-fail '$out' "$out" \
      --replace-fail '${glibcLocales}' "${glibcLocales}" \
      --replace-fail '${qtbase}' "${qtbase}" \
      --replace-fail '${qtdeclarative}' "${qtdeclarative}" \
      --replace-fail '${qtwebchannel}' "${qtwebchannel}" \
      --replace-fail '${qtwebengine}' "${qtwebengine}"

    chmod +x "$out/bin/jellyfinmediaplayer"
  '';

  meta = with lib; {
    homepage = "https://github.com/jellyfin/jellyfin-media-player";
    description = "Jellyfin Desktop Client based on Plex Media Player";
    license = with licenses; [
      gpl2Only
      mit
    ];
    platforms = [ "aarch64-linux" "x86_64-linux" ]; # Simplified platforms
    maintainers = with maintainers; [
      jojosch
      kranzes
      paumr
    ];
    mainProgram = "jellyfinmediaplayer";
  };
}
