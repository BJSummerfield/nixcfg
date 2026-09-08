{ pkgs, inputs, ... }:
{
  system.stateVersion = 6;
  system.configurationRevision = inputs.self.rev or inputs.self.dirtyRev or null;

  nix = {
    settings.experimental-features = [
      "nix-command"
      "flakes"
    ];
    gc = {
      automatic = true;
      options = "--delete-older-than 14d";
    };
    optimise.automatic = true;
  };

  fonts.packages = [ pkgs.nerd-fonts.monaspace ];

  programs.fish.enable = true;
}
