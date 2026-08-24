# Matt Pocock's skill pack, pinned and flattened for agent discovery.
#
# Upstream nests skills as skills/<category>/<name>/SKILL.md. Claude only
# discovers skills exactly one level under its skills directory - a nested
# tree yields zero skills and no error, which is why this flattens rather
# than symlinking the upstream tree straight in. Pi would recurse either
# way; one shape keeps both agents reading the same directory.
#
# `deprecated` and `in-progress` are dropped deliberately: the first is
# upstream's own graveyard, the second is unfinished.
#
# Bump: change rev, set hash to lib.fakeHash, build, paste the real hash.
pkgs:
let
  src = pkgs.fetchFromGitHub {
    owner = "mattpocock";
    repo = "skills";
    rev = "6654f6b60cd9d5be8b54c6fafe44346dabeb3b76";
    hash = "sha256-N5tpUIHO2VFeJntBTl6/VLDIVpqoshwFxNJlfXXUwsQ=";
  };
in
pkgs.runCommand "mattpocock-skills" { } ''
  mkdir -p $out
  for category in engineering productivity misc; do
    for skill in ${src}/skills/$category/*/; do
      [ -f "$skill/SKILL.md" ] || continue
      name=$(basename "$skill")
      # Flattening collapses three namespaces into one. A collision would
      # otherwise silently merge two skills' files together.
      if [ -e "$out/$name" ]; then
        echo "duplicate skill name across categories: $name" >&2
        exit 1
      fi
      cp -r "$skill" "$out/$name"
    done
  done
  chmod -R u+w $out
''
