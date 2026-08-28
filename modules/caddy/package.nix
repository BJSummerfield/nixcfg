# Caddy with the out-of-tree layer4 app compiled in. A caddy bump in
# nixpkgs invalidates `hash` - and so does a bump of nixpkgs' default Go,
# because the vendoring step's output embeds toolchain-dependent bytes
# (2026-08-28: go 1.26.5 -> 1.26.7 alone changed it, caddy untouched). CI
# catches either as a pkg-caddy-l4 build failure and hosts stay on their
# last good build.
{ caddy }:
(caddy.withPlugins {
  plugins = [ "github.com/mholt/caddy-l4@v0.1.2" ];
  hash = "sha256-C+ksbA6ucY3GUsYHSUhkYoh1gTP8SIAJv0MLjhX8BQM=";
}).overrideAttrs
  (old: {
    # Opt in to the binary cache: vps must substitute its edge, never
    # compile it.
    passthru = (old.passthru or { }) // {
      cache = true;
    };
  })
