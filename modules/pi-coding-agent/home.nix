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

    # ~/.pi/agent/settings.json - the seeded package membership and the
    # subagent model routing. Copied, not linked: pi's own package manager
    # rewrites this file
    # on `pi install` / `pi remove` / `pi update --extensions`, and that
    # write dies with EROFS through a store symlink - worse than the
    # extension-config case, because pi swallows the failure (exit 0,
    # "Installed" printed, nothing recorded, and the package does not load
    # on the next start). The seeded specs carry no
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
