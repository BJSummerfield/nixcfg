{
  runCommand,
  fetchurl,
  writeText,
}:

let
  version = "0.84.0";
  patch = writeText "pi-subagents-group-kill.diff" (builtins.readFile ./pi-subagents-group-kill.diff);
  jsTemporalPolyfill = fetchurl {
    url = "https://registry.npmjs.org/@js-temporal%2fpolyfill/-/polyfill-0.5.1.tgz";
    hash = "sha256-yZpNpWeKVaM9/TDJd4Ut+sm757i6xzmZ8YWMFnvms+M=";
  };
  acorn = fetchurl {
    url = "https://registry.npmjs.org/acorn/-/acorn-8.18.0.tgz";
    hash = "sha256-CtTA8o+bxbtvPrh5tP04Jl3vbX4eXWH5b3juaop76Uo=";
  };
  jiti = fetchurl {
    url = "https://registry.npmjs.org/jiti/-/jiti-2.7.0.tgz";
    hash = "sha256-jdDTZftJwOfMQtagDfb7LakFb8JEkglDRvw07NvPKMo=";
  };
  undici = fetchurl {
    url = "https://registry.npmjs.org/undici/-/undici-8.12.3.tgz";
    hash = "sha256-4D+i7TR1J8kVAmwEgQ07m8+Yk6IXazFKpMKclFYS0Yw=";
  };
  yaml = fetchurl {
    url = "https://registry.npmjs.org/yaml/-/yaml-2.8.3.tgz";
    hash = "sha256-lTmAXXRH3vK+1cW0rKzCgzYsXoCrxdk0crLzXwy/ha0=";
  };
  jsbi = fetchurl {
    url = "https://registry.npmjs.org/jsbi/-/jsbi-4.3.2.tgz";
    hash = "sha256-Ex0TSI8PQAoHcOrKSVdJzd7zTTFfeuskj8UB91OLN44=";
  };
in
runCommand "pi-subagents-${version}-group-kill"
  {
    src = fetchurl {
      url = "https://registry.npmjs.org/pi-subagents/-/pi-subagents-${version}.tgz";
      hash = "sha256-+cA4qsldhgx623fwKRm1AW9BD4Zw9BqMuRG1ZZh0KgI=";
    };
    dontUnpack = true;
  }
  ''
    mkdir -- "$TMPDIR/unpacked"
    tar --extract --file=$src --directory="$TMPDIR/unpacked"
    cd "$TMPDIR/unpacked/package"
    patch -p1 --fuzz=0 < ${patch}
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
