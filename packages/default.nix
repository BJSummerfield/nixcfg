{ pkgs }:
{
  encode_queue = pkgs.callPackage ../modules/encode_queue/package.nix { };
  keybase-notify = pkgs.callPackage ../modules/keybase-notify/package.nix { };
  inherit (import ../modules/local-llm/eval/tools.nix { inherit pkgs; })
    ninfer-pi-corpus
    ninfer-greedy-check
    ninfer-eval-harness
    ninfer-bfcl-pair
    ;
}
