{ lib, config, inputs, ... }:
let

  inherit (lib) mkIf;
  inherit (config.mine) user;
  cfg = config.mine.user.home-manager;
in
{
  imports = [
    inputs.home-manager.nixosModules.home-manager
  ];

  config = mkIf cfg.enable {
    home-manager = {
      useUserPackages = true;
      extraSpecialArgs = {
        inherit inputs;
        inherit user;
      };
      programs.home-manager.enable = true;
      home = {
        username = "${user.name}";
        stateVersion = "24.05";
        homeDirectory = "${user.homeDir}";
      };
    };
  };
}
