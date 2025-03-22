{ pkgs, ... }:
{
  bicep-lsp = pkgs.callPackage ./bicep-lsp { };
  mpls = pkgs.callPackage ./mpls { };
}
