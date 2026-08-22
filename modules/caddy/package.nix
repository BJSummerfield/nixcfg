# Caddy with the out-of-tree layer4 app compiled in. A caddy bump in
# nixpkgs invalidates `hash`; CI catches that as a pkg-caddy-l4 build
# failure and hosts stay on their last good build.
{ caddy }:
(caddy.withPlugins {
  plugins = [ "github.com/mholt/caddy-l4@v0.1.2" ];
  hash = "sha256-UIv8PxtJMlX7qClnPazFsSSl7G1BzsTT8VjrMIfB46Q=";
}).overrideAttrs
  (old: {
    # Opt in to the binary cache: vps must substitute its edge, never
    # compile it.
    passthru = (old.passthru or { }) // {
      cache = true;
    };
  })
