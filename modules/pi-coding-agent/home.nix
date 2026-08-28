{
  lib,
  config,
  pkgs,
  ...
}:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.pi-coding-agent;
  data = import ./settings.nix;

  # Deliberately a bare store file rather than a home.file entry - see the
  # activation script below.
  superagentsConfig = pkgs.writeText "pi-superagents-config.json" (builtins.toJSON data.superagents);
  # Seeded copy of ~/.pi/agent/settings.json (pi's package registry) -
  # written by the activation below, not by the home-manager module; see
  # the programs block and the piSettings activation for why.
  piSettings = pkgs.writeText "pi-settings.json" (builtins.toJSON data.settings);
in
{
  options.mine.user.pi-coding-agent = {
    enable = mkEnableOption "pi AI coding agent";
  };
  config = mkIf cfg.enable {
    # pi-web-access provider config (keyless); seeded declaratively so a
    # freshly built container comes up with search already configured
    # instead of needing a manual first-run setup.
    home.file.".pi/agent/web-search.json".text = builtins.toJSON data.webSearch;

    # pi-superagents user config; merged over the package's bundled
    # defaults, see the comment in settings.nix.
    #
    # Copied, not linked. home.file would make this a symlink into
    # /nix/store, which is mounted read-only (ro,nosuid,nodev on every host
    # here), and pi-superagents rewrites this exact path on every startup:
    # its install migration (applyInstallMigrations in
    # src/execution/config-migration.ts) copies a backup and then
    # writeFileSync's the merged config over the original. Through a store
    # symlink that write dies with `EROFS: read-only file system`, so the
    # extension never finishes loading - and because the write is what
    # would have recorded the migration as done, every subsequent pi launch
    # retries it and leaves another mode-444 config.json.bak-<timestamp>
    # next to the file. A writable copy migrates once and is then a no-op.
    #
    # entryAfter linkGeneration, not writeBoundary, so home-manager's own
    # link and orphan-cleanup pass can never race this copy. rm before
    # install because install(1) opens the destination through an existing
    # symlink, which is exactly the read-only target being replaced.
    #
    # Unconditional: the file stays a pure function of settings.nix, so a
    # rebuild also repairs a container still holding an old copy. The cost
    # is that anything /sp-settings or the migration wrote is reset on the
    # next activation - edit settings.nix instead.
    home.activation.piSuperagentsConfig = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
      run mkdir -p $VERBOSE_ARG "$HOME/.pi/agent/extensions/subagent"
      run rm -f $VERBOSE_ARG "$HOME/.pi/agent/extensions/subagent/config.json"
      run install $VERBOSE_ARG -m 0644 ${superagentsConfig} \
        "$HOME/.pi/agent/extensions/subagent/config.json"
    '';

    # ~/.pi/agent/settings.json - the seeded package membership. Copied,
    # not linked, for the same reason as the superagents config above: pi's
    # own package manager rewrites this file on `pi install` / `pi remove`
    # / `pi update --extensions`, and that write dies with EROFS through a
    # store symlink - worse than the superagents case, because pi swallows
    # the failure (exit 0, "Installed" printed, nothing recorded, and the
    # package does not load on the next start). The seeded specs carry no
    # versions (plugins.nix declares membership only), so the rebuild's
    # overwrite re-asserts *which* plugins without pinning *which version*
    # - a live `pi update --extensions` or `pi install ...@<ref>` floats
    # the installed versions and persists across rebuilds. An interim pin
    # against a bad release is the one-line version/ref addition to
    # plugins.nix. models.json stays a store symlink because pi treats it
    # as input-only.
    home.activation.piSettings = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
      run mkdir -p $VERBOSE_ARG "$HOME/.pi/agent"
      run rm -f $VERBOSE_ARG "$HOME/.pi/agent/settings.json"
      run install $VERBOSE_ARG -m 0644 ${piSettings} "$HOME/.pi/agent/settings.json"
    '';

    programs.pi-coding-agent = {
      enable = true;
      # shared with modules/devbox/container.nix, which wraps pi by hand -
      # see the header of extra-packages.nix
      extraPackages = import ./extra-packages.nix pkgs;
      # settings = {} on purpose: the upstream home-manager module would
      # otherwise write ~/.pi/agent/settings.json as a store symlink (its
      # write is mkIf (settings != {}), so an empty attrset opts out
      # cleanly). pi needs that file writable - the piSettings activation
      # above seeds it from this same data.settings.
      settings = { };
      models = data.models;
    };
  };
}
