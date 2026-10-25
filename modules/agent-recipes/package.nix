{
  writeShellApplication,
  symlinkJoin,
  nodejs,
  git,
  bash,
}:
let
  tree = builtins.path {
    path = ./.;
    name = "agent-recipes-src";
  };
  tool =
    name: script:
    writeShellApplication {
      inherit name;
      runtimeInputs = [
        nodejs
        git
        bash
      ];
      text = ''
        exec node ${tree}/${script} "$@"
      '';
    };
in
symlinkJoin {
  name = "agent-recipes-tools";
  paths = [
    (tool "recipe-gate" "gates/recipe-gate.mjs")
    (tool "recipe-smoke" "smoke/cli.mjs")
    (tool "recipe-sizing" "sizing/recipe-sizing.mjs")
    (tool "recipe-status" "status/recipe-status.mjs")
    (tool "recipe-run" "runner/cli.mjs")
  ];
}
