{ pkgs }:
let
  inherit (pkgs) lib;
  inherit (pkgs.callPackage ../ninfer-package.nix { }) src;

  render = pkgs.writers.writePython3Bin "ninfer-pi-corpus-render" {
    libraries = [ pkgs.python3Packages.jinja2 ];
    flakeIgnore = [ "E501" ];
  } (builtins.readFile ./ninfer_pi_corpus.py);
in
{
  ninfer-pi-corpus = pkgs.writeShellScriptBin "ninfer-pi-corpus" ''
    exec ${lib.getExe render} --template ${src}/tools/chat_templates/qwen3_8.jinja "$@"
  '';

  ninfer-greedy-check = pkgs.writers.writePython3Bin "ninfer-greedy-check" {
    flakeIgnore = [ "E501" ];
  } (builtins.readFile ./ninfer_greedy_check.py);

  ninfer-eval-harness = pkgs.writeShellApplication {
    name = "ninfer-eval-harness";
    runtimeInputs = [
      pkgs.python312
      pkgs.coreutils
    ];
    text = ''
      venv=''${NINFER_EVAL_VENV:-$HOME/.cache/ninfer-eval-venv}
      stamp="${pkgs.python312} ${src}"
      export LD_LIBRARY_PATH=${
        lib.makeLibraryPath [
          pkgs.stdenv.cc.cc.lib
          pkgs.zlib
        ]
      }
      export PYTHONPATH=${src}/eval
      if [ "$(cat "$venv/.stamp" 2>/dev/null)" != "$stamp" ]; then
        rm -rf "$venv"
        python3.12 -m venv "$venv"
        export TMPDIR=$venv/.tmp
        mkdir -p "$TMPDIR"
        "$venv/bin/pip" install --extra-index-url https://download.pytorch.org/whl/cpu \
          -r ${src}/eval/requirements.txt
        rm -rf "$TMPDIR"
        echo "$stamp" >"$venv/.stamp"
      fi
      exec "$venv/bin/python" -m ninfer_eval "$@"
    '';
  };
}
