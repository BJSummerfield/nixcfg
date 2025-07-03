# Edit this configuration file to define what should be installed on
# your system.  Help is available in the configuration.nix(5) man page
# and in the NixOS manual (accessible by running ‘nixos-help’).

{ config, pkgs, lib, ... }:

{
  imports =
    [
      ./hardware-configuration.nix
      ../../modules
    ];

  config = {
    mine = {
      system = {
        bootPartitionUuid = "5cccbb79-6ae4-4a43-add1-9b5fa0a03e18";
      };
      cli-tools = {
        git.enable = true;
        lazygit.enable = true;
        eza.enable = true;
        direnv.enable = true;
      };
    };
  };
}
