{ config
, pkgs
, inputs
, ...
}: {
  users.users.waktu = {
    initialHashedPassword = "$y$j9T$IoChbWGYRh.rKfmm0G86X0$bYgsWqDRkvX.EBzJTX.Z0RsTlwspADpvEF3QErNyCMC";
    isNormalUser = true;
    description = "waktu";
    extraGroups = [
      "wheel"
      "networkmanager"
    ];
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILtTarFZkhNoHtu39C6eCRaS84jb6SPoY92gn64Q2D3O"
    ];
    packages = [ inputs.home-manager.packages.${pkgs.system}.default ];
  };
  home-manager.users.waktu =
    import ../../../home/waktu/${config.networking.hostName}.nix;
}
