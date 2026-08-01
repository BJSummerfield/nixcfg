# OCI image for running the coding agents where nspawn isn't available
# (macOS via Docker Desktop). The docker counterpart of container.nix:
# same shared config, `docker run --rm` per session gives the same
# ephemeral semantics as the nspawn pool. Exposed as
# packages.<linux-system>.coding-agents-image.
{ pkgs }:
let
  data = import ../pi-coding-agent/settings.nix;
  opencodeData = import ../opencode/settings.nix;
  json = pkgs.formats.json { };

  agentHome = pkgs.runCommand "coding-agents-home" { } ''
    mkdir -p $out/root/.pi/agent $out/root/.config/opencode
    cp ${json.generate "settings.json" data.settings} $out/root/.pi/agent/settings.json
    cp ${json.generate "models.json" data.models} $out/root/.pi/agent/models.json
    cp ${json.generate "web-search.json" data.webSearch} $out/root/.pi/agent/web-search.json
    cp ${json.generate "opencode.json" opencodeData.settings} $out/root/.config/opencode/opencode.json
    cp ${../pi-coding-agent/APPEND_SYSTEM_IMAGE.md} $out/root/.pi/agent/APPEND_SYSTEM.md

    # Unsigned commits: the signing key stays on the host.
    cat > $out/root/.gitconfig <<'EOF'
    [user]
      name = BJSummerfield
      email = brianjsummerfield@gmail.com
    EOF
  '';
in
pkgs.dockerTools.buildLayeredImage {
  name = "coding-agents";
  tag = "latest";

  contents = with pkgs; [
    agentHome
    dockerTools.binSh
    dockerTools.caCertificates
    dockerTools.fakeNss
    bashInteractive
    claude-code
    coreutils
    curl
    fd
    git
    jq
    nodejs
    opencode
    pi-coding-agent
    ripgrep
  ];

  config = {
    Cmd = [ "pi" ];
    WorkingDir = "/workspace";
    Env = [
      "HOME=/root"
      "PATH=/bin:/usr/bin"
      # Claude keeps its login/config in the state dir the launcher
      # mounts from the host; the nix-store binary can't self-update.
      "CLAUDE_CONFIG_DIR=/root/.claude-state"
      "DISABLE_AUTOUPDATER=1"
    ];
  };
}
