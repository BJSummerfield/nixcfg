{ pkgs, ... }:
{
  bicep-langserver = pkgs.callPackage ./bicep-langserver { };
  mpls = pkgs.callPackage ./mpls { };
  encode_queue = pkgs.callPackage ./encode_queue { };
}
