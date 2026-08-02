# Run the coding agents in throwaway docker containers, mirroring the
# ephemeral nspawn setup on the nixos hosts. The image is this flake's own
# packages.aarch64-linux.coding-agents-image, built on demand through the
# linux-builder VM.
{ pkgs, lib, config, inputs, ... }:
let
  inherit (lib) mkIf optionals;
  inherit (import ./options.nix lib) mkAgentOptions;
  cfg = config.mine.system.coding-agents;

  image = inputs.self.packages.aarch64-linux.coding-agents-image;
  # The image's out path, known at eval time without building it. Used only
  # to derive a stable docker tag, so config changes that don't touch the
  # image don't cause a rebuild or re-load.
  imageOut = builtins.unsafeDiscardStringContext image.outPath;

  mkLauncher = { name, cmd, extraDockerArgs ? [ ], setup ? "" }:
    pkgs.writeShellScriptBin name ''
      set -euo pipefail
      ${setup}
      tag=$(basename ${imageOut} | cut -c1-8)
      if ! docker image inspect "coding-agents:$tag" >/dev/null 2>&1; then
        echo "building coding-agents image (first run after an update takes a while)..." >&2
        out=$(nix build --no-link --print-out-paths "path:${inputs.self}#packages.aarch64-linux.coding-agents-image")
        docker load < "$out"
        docker tag coding-agents:latest "coding-agents:$tag"
      fi
      exec docker run --rm -it \
        -e TERM="''${TERM:-xterm-256color}" \
        ${toString extraDockerArgs} \
        -v "$PWD:/workspace" \
        "coding-agents:$tag" ${cmd} "$@"
    '';

  launchers =
    optionals cfg.agents.pi [ (mkLauncher { name = "pi"; cmd = "pi"; }) ]
    ++ optionals cfg.agents.opencode [ (mkLauncher { name = "opencode"; cmd = "opencode"; }) ]
    # Ephemeral containers, but claude's login/config state survives in a
    # dedicated host dir so auth happens once per machine, not per session.
    ++ optionals cfg.agents.claude [
      (mkLauncher {
        name = "claude";
        cmd = "claude";
        # Pre-create the state dir: docker creates missing -v host dirs
        # itself, owned by root, which would break state persistence.
        setup = ''mkdir -p "$HOME/.local/state/claude-sandbox"'';
        extraDockerArgs = [ ''-v "$HOME/.local/state/claude-sandbox:/root/.claude-state"'' ];
      })
    ];
in
{
  options.mine.system.coding-agents = mkAgentOptions;

  config = mkIf cfg.enable {
    # Managed NixOS build VM so this mac can build the aarch64-linux image.
    nix.linux-builder.enable = true;

    # The launchers shell out to docker at runtime.
    homebrew.casks = [ "docker-desktop" ];

    environment.systemPackages = launchers;
  };
}
