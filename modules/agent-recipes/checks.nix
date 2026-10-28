{
  pkgs,
  lib,
  resolved,
}:
let
  recipeSrc = builtins.path {
    path = ./.;
    name = "agent-recipes-src";
  };
  tools = pkgs.callPackage ./package.nix { };
  run =
    name: test: after:
    pkgs.runCommand name {
      nativeBuildInputs = [
        pkgs.nodejs
        pkgs.git
        pkgs.bash
      ];
    } "cp -r --no-preserve=mode ${recipeSrc} src; cd src; node ${test}\n${after}touch $out";
  testFiles =
    rel:
    let
      abs = if rel == "" then ./. else ./. + "/${rel}";
    in
    lib.concatLists (
      lib.mapAttrsToList (
        n: type:
        let
          p = if rel == "" then n else "${rel}/${n}";
        in
        if type == "directory" then
          testFiles p
        else if type == "regular" && lib.hasSuffix ".test.mjs" n then
          [ p ]
        else
          [ ]
      ) (builtins.readDir abs)
    );
  nameOf =
    file: "pi-recipe-${lib.replaceStrings [ "/" ] [ "-" ] (lib.removeSuffix ".test.mjs" file)}";
in
lib.listToAttrs (
  map (
    file:
    let
      name = nameOf file;
      after =
        if file == "gates/recipe-git.test.mjs" then
          ''
            status=0
            ${tools}/bin/recipe-gate bogus x || status=$?
            test "$status" = 2
          ''
        else
          "";
    in
    lib.nameValuePair name (run name file after)
  ) (testFiles "")
)
// {
  pi-recipe-skills =
    pkgs.runCommand "pi-recipe-skills"
      {
        nativeBuildInputs = [ (pkgs.python3.withPackages (p: [ p.pyyaml ])) ];
      }
      ''
        python3 -I -c '
        import sys, yaml
        errors = []
        for path in sys.argv[1:]:
            parts = open(path).read().split("---\n")
            try:
                meta = yaml.safe_load(parts[1]) if parts[0] == "" and len(parts) > 2 else None
            except yaml.YAMLError as e:
                errors.append(f"{path}: {e}")
                continue
            if not isinstance(meta, dict) or not meta.get("name") or not meta.get("description"):
                errors.append(f"{path}: frontmatter needs name and description")
        if errors:
            sys.exit("\n".join(errors))
        ' ${recipeSrc}/*/SKILL.md
        touch $out
      '';

  pi-recipe-budgets =
    pkgs.runCommand "pi-recipe-budgets"
      {
        nativeBuildInputs = [ pkgs.nodejs ];
        passAsFile = [ "data" ];
        data = builtins.toJSON resolved;
      }
      ''
        node -e '
          const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
          const names = ["implementer", "scout", "locator", "planner", "reviewer", "synthesizer", "searcher", "extractor", "mutator"];
          const xhigh = ["planner", "reviewer", "synthesizer"];
          const errors = [];
          for (const n of names) {
            const b = d.roles[n]?.budget;
            if (!b) { errors.push(n + ": no budget"); continue; }
            if (!Number.isInteger(b.tokens) || b.tokens <= 0) errors.push(n + ": tokens");
            if (!Number.isInteger(b.reserve) || b.reserve <= 0) errors.push(n + ": reserve");
            if (!["commit", "unread", "stop"].includes(b.action)) errors.push(n + ": action");
            if (b.tokens + b.reserve > d.window - d.compactionReserve) errors.push(n + ": no room for the handoff turn");
            if (xhigh.includes(n) && b.reserve < d.maxTokens) errors.push(n + ": reserve below one reply");
          }
          if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
        ' "$dataPath"
        touch $out
      '';
}
