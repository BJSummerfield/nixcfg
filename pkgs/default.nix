{ pkgs, ... }:
{
  bicep-langserver = pkgs.callPackage ./bicep-langserver { };
  mpls = pkgs.callPackage ./mpls { };
}
