{ lib, pkgs }:
modelName: entry:
pkgs.linkFarm modelName (
  lib.mapAttrsToList (file: hash: {
    name = file;
    path = pkgs.fetchurl {
      url = "https://huggingface.co/${entry.repo}/resolve/main/${file}";
      inherit hash;
    };
  }) entry.files
)
