{ lib, ... }:

let
  inherit (lib) mkEnableOption;
in
{
  options.mine.system.polkit.enable = mkEnableOption "Enable Polkit";
}
