{
  config,
  pkgs,
  inputs,
  ...
}: {
  users.users.waktu= {
    initialHashedPassword = "$y$j9T$IoChbWGYRh.rKfmm0G86X0$bYgsWqDRkvX.EBzJTX.Z0RsTlwspADpvEF3QErNyCMC";
    isNormalUser = true;
    description = "waktu";
    extraGroups = [
      "wheel"
      "networkmanager"
    ];
    packages = [inputs.home-manager.packages.${pkgs.system}.default];
  };
  home-manager.users.waktu =
    import ../../../home/waktu/${config.networking.hostName}.nix;
}
