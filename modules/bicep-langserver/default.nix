{ ... }:
{
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
}
