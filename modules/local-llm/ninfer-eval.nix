{
  lib,
  pkgs,
  ninfer,
  artifact,
}:
let
  outRoot = "/var/lib/ninfer-eval/ppl";

  ninfer-ppl = pkgs.writeShellApplication {
    name = "ninfer-ppl";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.systemd
    ];
    text = ''
      if [ $# -lt 1 ]; then
        echo "usage: ninfer-ppl <bf16|int8|fp8|nvfp4|k8v4> [--corpus MANIFEST | --text FILE] [--quick] [ninfer-perplexity flags]" >&2
        echo "defaults: upstream corpus ninfer-ppl-1m-v1, --context 65536 --stride 32768, report under ${outRoot}" >&2
        exit 2
      fi
      if systemctl is-active --quiet ninfer.service; then
        echo "ninfer.service holds the GPU; run 'systemctl stop ninfer' first and 'systemctl start ninfer' after" >&2
        exit 1
      fi
      kv=$1
      shift
      source=(--corpus ${ninfer.src}/eval/corpora/perplexity-1m/manifest.json)
      for arg in "$@"; do
        case $arg in --corpus | --text) source=() ;; esac
      done
      out=${outRoot}/$(date +%Y%m%d-%H%M%S)-$kv
      mkdir -p ${outRoot}
      ${lib.getExe' ninfer "ninfer-perplexity"} ${artifact} \
        "''${source[@]}" --context 65536 --stride 32768 --kv-dtype "$kv" --output "$out" "$@" \
        2>&1 | tee "$out.log"
    '';
  };

  ninfer-ppl-compare = pkgs.writers.writePython3Bin "ninfer-ppl-compare" {
    flakeIgnore = [ "E501" ];
  } (builtins.readFile ./eval/ninfer_ppl_compare.py);
in
[
  ninfer-ppl
  ninfer-ppl-compare
]
