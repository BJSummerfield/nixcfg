# Central allocation of container veth address pairs on the 192.168.100.0/24
# range. Modules read their pair from here instead of hardcoding it, so the
# free numbers are visible in one place instead of eleven. Not a NixOS
# module - it has nothing to configure - just an attrset, imported directly
# wherever an address is needed.
#
# Uniqueness across every container on a host is enforced at eval time by the
# assertion in modules/devbox/nixos.nix; this table is where you look before
# picking a new pair, not what stops a collision.
{
  jellyfin-server = {
    host = "192.168.100.10";
    local = "192.168.100.11";
  };
  teamspeak-server = {
    host = "192.168.100.12";
    local = "192.168.100.13";
  };
  dns-server = {
    host = "192.168.100.14";
    local = "192.168.100.15";
  };
  immich-server = {
    host = "192.168.100.20";
    local = "192.168.100.21";
  };
  vikunja-server = {
    host = "192.168.100.22";
    local = "192.168.100.23";
  };
  local-llm = {
    host = "192.168.100.24";
    local = "192.168.100.25";
  };
  devbox = {
    host = "192.168.100.26";
    local = "192.168.100.27";
  };
  workbox = {
    host = "192.168.100.28";
    local = "192.168.100.29";
  };
  terraria-server = {
    host = "192.168.100.30";
    local = "192.168.100.31";
  };
  stalwart-server = {
    host = "192.168.100.40";
    local = "192.168.100.41";
  };
  photoform = {
    host = "192.168.100.50";
    local = "192.168.100.51";
  };
}
