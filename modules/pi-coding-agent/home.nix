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
  subagentsConfig = pkgs.writeText "pi-subagents-config.json" (builtins.toJSON data.subagentsConfig);
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

    # The custom agents pi-subagents discovers under ~/.pi/agent/agents.
    # Only one lives here: `wp`, the sub-orchestrator. scout, researcher,
    # worker, reviewer, oracle and delegate ship as builtins, and their
    # models and thinking levels come from settings.subagents.agentOverrides
    # rather than from copies of their files.
    #
    # A store symlink is fine here, unlike the two activations below: pi
    # only ever reads agent files. Three deliberate omissions in wp.md that
    # a future edit should not "fix":
    #   - no `model` / `thinking`: an agentOverrides entry fills only the
    #     fields a *custom* agent's frontmatter leaves unset, so declaring
    #     them here would take wp's tier out of settings.nix.
    #   - no `maxSubagentDepth`: it is a ceiling applied to the agent
    #     itself, so `1` on a depth-1 sub-orchestrator blocks every dispatch
    #     it makes. The global 2 already stops wp's children.
    #   - no `extensions`: the field is an allowlist of extension *paths*,
    #     and its presence disables every other discovered extension. Left
    #     off, wp keeps pi-web-access and can research without a child.
    home.file.".pi/agent/agents".source = ./agents;

    # pi-subagents' extension config; merged over the package's bundled
    # defaults, see the comment in settings.nix.
    #
    # Copied, not linked. home.file would make this a symlink into
    # /nix/store, which is mounted read-only (ro,nosuid,nodev on every host
    # here), and the extension writes this exact path back whenever
    # something updates it in place (updateConfig in
    # src/extension/config.ts read-modify-writes the whole file). Through a
    # store symlink that write dies with `EROFS: read-only file system`.
    # The predecessor plugin made this sharper still - it rewrote the file
    # during an install migration on every startup, and because that write
    # was also what recorded the migration as done, each launch retried it
    # and left another mode-444 config.json.bak-<timestamp> behind. A
    # writable copy has neither failure.
    #
    # entryAfter linkGeneration, not writeBoundary, so home-manager's own
    # link and orphan-cleanup pass can never race this copy. rm before
    # install because install(1) opens the destination through an existing
    # symlink, which is exactly the read-only target being replaced.
    #
    # Unconditional: the file stays a pure function of settings.nix, so a
    # rebuild also repairs a container still holding an old copy. The cost
    # is that a runtime edit is reset on the next activation - edit
    # settings.nix instead.
    #
    # The .bak sweep clears the mode-444 debris the old install migration
    # left; nothing else prunes it, and it is dead weight either way.
    home.activation.piSubagentsConfig = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
      run mkdir -p $VERBOSE_ARG "$HOME/.pi/agent/extensions/subagent"
      run rm -f $VERBOSE_ARG "$HOME/.pi/agent/extensions/subagent/config.json" \
        "$HOME/.pi/agent/extensions/subagent"/config.json.bak-*
      run install $VERBOSE_ARG -m 0644 ${subagentsConfig} \
        "$HOME/.pi/agent/extensions/subagent/config.json"
    '';

    # ~/.pi/agent/settings.json - the seeded package membership and the
    # subagent role tiering. Copied, not linked, for the same reason as the
    # extension config above: pi's own package manager rewrites this file
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
