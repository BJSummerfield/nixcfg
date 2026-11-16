{ pkgs }:
modelName: artifact:
pkgs.fetchurl {
  name = "${modelName}.ninfer";
  url = "https://huggingface.co/${artifact.repo}/resolve/${artifact.revision}/${artifact.file}";
  inherit (artifact) hash;
}
