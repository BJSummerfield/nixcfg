# PaperWM scrolling window management via Hammerspoon: the mac analog of
# niri. The Hammerspoon app itself comes from the homebrew cask; this only
# manages its config.
{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.hammerspoon;
in
{
  options.mine.user.hammerspoon.enable = mkEnableOption "Hammerspoon PaperWM config";

  config = mkIf cfg.enable {
    home.file = {
      ".hammerspoon/init.lua".source = ./init.lua;
      ".hammerspoon/Spoons/PaperWM.spoon" = {
        recursive = true;
        source = pkgs.fetchFromGitHub {
          owner = "mogenson";
          repo = "PaperWM.spoon";
          rev = "release";
          hash = "sha256-m8gEIeyZPQ43jj2cus+Ks1K9GqrmQMv07XR33Ppobms=";
        };
      };
    };
  };
}
