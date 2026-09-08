{ caddy }:
(caddy.withPlugins {
  plugins = [ "github.com/mholt/caddy-l4@v0.1.2" ];
  hash = "sha256-C+ksbA6ucY3GUsYHSUhkYoh1gTP8SIAJv0MLjhX8BQM=";
}).overrideAttrs
  (old: {
    passthru = (old.passthru or { }) // {
      cache = true;
    };
  })
