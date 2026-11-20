{
  writeShellApplication,
  depotdownloader,
  coreutils,
  findutils,
  gawk,
  gnugrep,
  util-linux,
  systemd,
}:
writeShellApplication {
  name = "valheim-updater";
  runtimeInputs = [
    depotdownloader
    coreutils
    findutils
    gawk
    gnugrep
    util-linux
    systemd
  ];
  text = builtins.readFile ./updater.sh;
}
