{ caddy }:
(caddy.withPlugins {
  plugins = [ "github.com/mholt/caddy-l4@v0.1.2" ];
  hash = "sha256-lgeo9zTTTx0S2CI8f4LgfoDngdvmlwiNM5QwS5e4ozw=";
}).overrideAttrs
  (old: {
    passthru = (old.passthru or { }) // {
      cache = true;
    };
  })
