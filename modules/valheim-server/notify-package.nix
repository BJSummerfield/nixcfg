{
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
  text = builtins.readFile ./notify.sh;
}
