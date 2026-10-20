{
  writeShellApplication,
  symlinkJoin,
  nodejs,
}:
let
  tool =
    name: script:
    writeShellApplication {
      inherit name;
      runtimeInputs = [ nodejs ];
      text = ''
        exec node ${script} "$@"
      '';
    };
in
symlinkJoin {
  name = "agent-recipes-tools";
  paths = [
    (tool "recipe-gate" ./gates/recipe-gate.mjs)
    (tool "recipe-sizing" ./sizing/recipe-sizing.mjs)
    (tool "recipe-status" ./status/recipe-status.mjs)
  ];
}
