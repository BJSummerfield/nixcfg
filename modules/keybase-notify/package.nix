{
  lib,
  writeShellApplication,
  curl,
  jq,
  coreutils,
  urlFile ? "",
  prefix ? "",
}:
writeShellApplication {
  name = "keybase-notify";
  runtimeInputs = [
    curl
    jq
    coreutils
  ];
  text = ''
    DEFAULT_URL_FILE=${lib.escapeShellArg urlFile}
    DEFAULT_PREFIX=${lib.escapeShellArg prefix}
  ''
  + builtins.readFile ./send.sh;
}
