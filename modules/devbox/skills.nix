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
  shopt -s nullglob
  mkdir -p $out

  # Every category upstream has must be either taken or deliberately
  # dropped. Without this, a rename or a newly added category on a rev bump
  # just produces fewer skills and no error - the silent shortfall this
  # derivation exists to prevent.
  for dir in ${src}/skills/*/; do
    case "$(basename "$dir")" in
      engineering | productivity | misc | deprecated | in-progress) ;;
      *)
        echo "unrecognised upstream skill category: $(basename "$dir")" >&2
        echo "take it below or add it to the deliberately-dropped list" >&2
        exit 1
        ;;
    esac
  done

  for category in engineering productivity misc; do
    if [ ! -d "${src}/skills/$category" ]; then
      echo "expected skill category is gone upstream: $category" >&2
      exit 1
    fi
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

  # Backstop for a layout change that leaves the category directories in
  # place but moves what is under them: zero skills must never be a
  # successful build, or both agents come up with no skills and no error.
  if [ -z "$(ls -A $out)" ]; then
    echo "no skills were copied - upstream layout changed?" >&2
    exit 1
  fi

  chmod -R u+w $out
''
