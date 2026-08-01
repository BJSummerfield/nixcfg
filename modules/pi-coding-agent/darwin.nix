# Run pi in throwaway docker containers, mirroring the ephemeral nspawn
# setup on the nixos hosts. The image is this flake's own
# packages.aarch64-linux.pi-agent-image, built on demand through the
# linux-builder VM.
{ pkgs, lib, config, inputs, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.system.pi-coding-agent;

  image = inputs.self.packages.aarch64-linux.pi-agent-image;
  # The image's out path, known at eval time without building it. Used only
  # to derive a stable docker tag, so config changes that don't touch the
  # image don't cause a rebuild or re-load.
  imageOut = builtins.unsafeDiscardStringContext image.outPath;

  launcher = pkgs.writeShellScriptBin "pi" ''
    set -euo pipefail
    tag=$(basename ${imageOut} | cut -c1-8)
    if ! docker image inspect "pi-agent:$tag" >/dev/null 2>&1; then
      echo "building pi-agent image (first run after an update takes a while)..." >&2
      out=$(nix build --no-link --print-out-paths "path:${inputs.self}#packages.aarch64-linux.pi-agent-image")
      docker load < "$out"
      docker tag pi-agent:latest "pi-agent:$tag"
    fi
    exec docker run --rm -it \
      -e TERM="''${TERM:-xterm-256color}" \
      -v "$PWD:/workspace" \
      "pi-agent:$tag" pi "$@"
  '';
in
{
  options.mine.system.pi-coding-agent.enable = mkEnableOption "pi coding agent in docker containers";

  config = mkIf cfg.enable {
    # Managed NixOS build VM so this mac can build the aarch64-linux image.
    nix.linux-builder.enable = true;

    # The launcher shells out to docker at runtime.
    homebrew.casks = [ "docker-desktop" ];

    environment.systemPackages = [ launcher ];
  };
}
