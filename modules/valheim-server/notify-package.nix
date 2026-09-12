{
  lib,
  writeShellApplication,
  coreutils,
  gnugrep,
  systemd,
}:
writeShellApplication {
  name = "valheim-notify";
  runtimeInputs = [
    coreutils
    gnugrep
    systemd
  ];
  text = ''
    DEFAULT_DEATH_LINES=${lib.escapeShellArg "${./death-lines.txt}"}
  ''
  + builtins.readFile ./notify.sh;
}
