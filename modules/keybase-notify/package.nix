{
  lib,
  writeShellApplication,
  curl,
  jq,
  coreutils,
  tzdata,
  urlFile ? "",
  prefix ? "",
  timeZone ? "America/Chicago",
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
    DEFAULT_TIME_ZONE=${lib.escapeShellArg timeZone}
    # Baked in so the time stamp doesn't depend on the host's or the
    # container's own zoneinfo.
    export TZDIR=${tzdata}/share/zoneinfo
  ''
  + builtins.readFile ./send.sh;
}
