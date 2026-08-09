# Catalog entry -> a directory of the model's HuggingFace files.
#
# A linkFarm of fetchurl'd blobs rather than a git/lfs clone: each shard is a
# fixed-output derivation, so the store dedupes them and a partial download
# retries just that shard. vLLM is handed this directory as its --model.
{ lib, pkgs }:
modelName: entry:
pkgs.linkFarm modelName (
  lib.mapAttrsToList
    (file: hash: {
      name = file;
      path = pkgs.fetchurl {
        url = "https://huggingface.co/${entry.repo}/resolve/main/${file}";
        inherit hash;
      };
    })
    entry.files
)
