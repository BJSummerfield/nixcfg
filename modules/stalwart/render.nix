{
  lib,
  writeText,
  cfg,
  webui,
}:
writeText "stalwart-plan.ndjson" (
  lib.concatMapStrings (op: (builtins.toJSON op) + "\n") (
    import ./plan.nix {
      inherit lib cfg webui;
    }
  )
)
