# OCI image for running pi where nspawn isn't available (macOS via Docker
# Desktop). The docker counterpart of container.nix: same shared config,
# `docker run --rm` per session gives the same ephemeral semantics as the
# nspawn pool. Exposed as packages.<linux-system>.pi-agent-image.
{ pkgs }:
let
  data = import ./settings.nix;
  json = pkgs.formats.json { };

  piHome = pkgs.runCommand "pi-agent-home" { } ''
    mkdir -p $out/root/.pi/agent
    cp ${json.generate "settings.json" data.settings} $out/root/.pi/agent/settings.json
    cp ${json.generate "models.json" data.models} $out/root/.pi/agent/models.json
    cp ${json.generate "web-search.json" data.webSearch} $out/root/.pi/agent/web-search.json
    cp ${./APPEND_SYSTEM_IMAGE.md} $out/root/.pi/agent/APPEND_SYSTEM.md

    # Unsigned commits: the signing key stays on the host.
    cat > $out/root/.gitconfig <<'EOF'
    [user]
      name = BJSummerfield
      email = brianjsummerfield@gmail.com
    EOF
  '';
in
pkgs.dockerTools.buildLayeredImage {
  name = "pi-agent";
  tag = "latest";

  contents = with pkgs; [
    piHome
    dockerTools.binSh
    dockerTools.caCertificates
    dockerTools.fakeNss
    bashInteractive
    coreutils
    curl
    fd
    git
    jq
    nodejs
    pi-coding-agent
    ripgrep
  ];

  config = {
    Cmd = [ "pi" ];
    WorkingDir = "/workspace";
    Env = [
      "HOME=/root"
      "PATH=/bin:/usr/bin"
    ];
  };
}
