{ config, pkgs, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.cli-tools.bicep-langserver;
in
{
  options.mine.cli-tools.bicep-langserver = {
    expose = mkEnableOption "Expose the bicep-langserver package via an overlay";
    enable = mkEnableOption "Install the bicep-langserver package";
  };

  config = mkIf (cfg.enable || cfg.expose) {
    nixpkgs.overlays = [
      (self: super: {
        bicep-langserver = super.stdenv.mkDerivation rec {
          pname = "bicep-langserver";
          version = "0.33.93";

          src = super.fetchzip {
            url = "https://github.com/Azure/bicep/releases/download/v${version}/bicep-langserver.zip";
            sha256 = "MDm2ZKcbgfxUa7h4PrtqgmvreLqnbso1Dc6y0uvar1A=";
            stripRoot = false;
          };

          installPhase = ''
            mkdir -p $out/bin
            cp -r $src $out/bin/Bicep.LangServer/

            cat <<EOF > $out/bin/bicep-langserver
            #!/usr/bin/env bash
            exec ${super.dotnetCorePackages.dotnet_8.sdk} $out/bin/Bicep.LangServer/Bicep.LangServer.dll "\$@"
            EOF
            chmod +x $out/bin/bicep-langserver
          '';

          meta = {
            description = "Bicep language server";
            homepage = "https://github.com/Azure/bicep";
            platforms = super.lib.platforms.all;
            mainProgram = "bicep-langserver";
          };
        };
      })
    ];

    home-manager.users.${user.name} = mkIf cfg.enable {
      home.packages = [ pkgs.bicep-langserver ];
    };
  };
}
