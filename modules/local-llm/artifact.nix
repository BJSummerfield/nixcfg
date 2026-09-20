# NInfer loads one self-contained .ninfer container, not a safetensors tree, so
# this is a single hash-checked file rather than weights.nix's linkFarm. The
# revision is pinned because the published artifact is rebuilt in place when the
# container format changes (v2 -> v3 did exactly that).
{ pkgs }:
modelName: artifact:
pkgs.fetchurl {
  name = "${modelName}.ninfer";
  url = "https://huggingface.co/${artifact.repo}/resolve/${artifact.revision}/${artifact.file}";
  inherit (artifact) hash;
}
