{
  # Vendored pi-subagents package: the upstream 0.78.0 npm tarball with
  # modules/pi-coding-agent/pi-subagents-group-kill.diff applied at build time.
  # Upstream has no process-group kill when a run ends on its deadline or a
  # stop, so a timed-out subagent could orphan its detached bash tool tree
  # (scene_gen #153: "deadlines must kill the process group").
  #
  # The build is fully offline: every npm tarball (this package plus its six
  # runtime deps; jsbi is pinned by @js-temporal/polyfill's caret range) is a
  # content-addressed fetchurl input, so node_modules/ is assembled without
  # npm and without a network build.
  #
  # Drop this file once upstream lands group-kill termination: re-pin
  # "npm:pi-subagents@<version>" in modules/devbox/plugins.nix, remove the
  # wiring in home.nix and the pi-subagents-group-kill check in checks/.

  runCommand,
  fetchurl,
  writeText,
}:

let
  version = "0.78.0";
  patch = writeText "pi-subagents-group-kill.diff" (builtins.readFile ./pi-subagents-group-kill.diff);
  # pi loads a local package from its root directory (the pi manifest in
  # package.json), so the runtime deps must sit in a node_modules/ next to it.
  jsTemporalPolyfill = fetchurl {
    url = "https://registry.npmjs.org/@js-temporal%2fpolyfill/-/polyfill-0.5.1.tgz";
    # Pinned npm registry tarball; content-addressed and re-verified on every build.
    hash = "sha256-yZpNpWeKVaM9/TDJd4Ut+sm757i6xzmZ8YWMFnvms+M=";
  };
  acorn = fetchurl {
    url = "https://registry.npmjs.org/acorn/-/acorn-8.18.0.tgz";
    # Pinned npm registry tarball; content-addressed and re-verified on every build.
    hash = "sha256-CtTA8o+bxbtvPrh5tP04Jl3vbX4eXWH5b3juaop76Uo=";
  };
  jiti = fetchurl {
    url = "https://registry.npmjs.org/jiti/-/jiti-2.7.0.tgz";
    # Pinned npm registry tarball; content-addressed and re-verified on every build.
    hash = "sha256-jdDTZftJwOfMQtagDfb7LakFb8JEkglDRvw07NvPKMo=";
  };
  undici = fetchurl {
    url = "https://registry.npmjs.org/undici/-/undici-8.10.2.tgz";
    # Pinned npm registry tarball; content-addressed and re-verified on every build.
    hash = "sha256-dAY4rjLXjSZGpnJ5UONl+ia2+oeRP6CW5g7Ur+tGNKo=";
  };
  yaml = fetchurl {
    url = "https://registry.npmjs.org/yaml/-/yaml-2.8.3.tgz";
    # Pinned npm registry tarball; content-addressed and re-verified on every build.
    hash = "sha256-lTmAXXRH3vK+1cW0rKzCgzYsXoCrxdk0crLzXwy/ha0=";
  };
  jsbi = fetchurl {
    url = "https://registry.npmjs.org/jsbi/-/jsbi-4.3.2.tgz";
    # Pinned npm registry tarball; content-addressed and re-verified on every build.
    hash = "sha256-Ex0TSI8PQAoHcOrKSVdJzd7zTTFfeuskj8UB91OLN44=";
  };
in
runCommand "pi-subagents-${version}-group-kill"
  {
    src = fetchurl {
      url = "https://registry.npmjs.org/pi-subagents/-/pi-subagents-${version}.tgz";
      # Pinned npm registry tarball; content-addressed and re-verified on every build.
      hash = "sha256-nEVi9mxZXZh4wEquMddnJwh9tuAlsZ7rqS07qxrIEsw=";
    };
    # The npm tarball unpacks into package/; extract it ourselves so the patch
    # paths (src/runs/background/...) stay plain.
    dontUnpack = true;
  }
  ''
    mkdir -- "$TMPDIR/unpacked"
    tar --extract --file=$src --directory="$TMPDIR/unpacked"
    cd "$TMPDIR/unpacked/package"
    patch -p1 --fuzz=0 < ${patch}
    # Assemble node_modules/ from the pinned tarballs (npm's layout, minus the
    # lockfile). Pi's peer packages are provided by pi itself at runtime, so
    # they are deliberately not installed here.
    mkdir --parents -- "node_modules/@js-temporal/polyfill"
    tar --extract --file=${jsTemporalPolyfill} --strip-components=1 --directory="node_modules/@js-temporal/polyfill"
    mkdir -- "node_modules/acorn"
    tar --extract --file=${acorn} --strip-components=1 --directory="node_modules/acorn"
    mkdir -- "node_modules/jiti"
    tar --extract --file=${jiti} --strip-components=1 --directory="node_modules/jiti"
    mkdir -- "node_modules/undici"
    tar --extract --file=${undici} --strip-components=1 --directory="node_modules/undici"
    mkdir -- "node_modules/yaml"
    tar --extract --file=${yaml} --strip-components=1 --directory="node_modules/yaml"
    mkdir -- "node_modules/jsbi"
    tar --extract --file=${jsbi} --strip-components=1 --directory="node_modules/jsbi"
    cp -a -- . $out
  ''
