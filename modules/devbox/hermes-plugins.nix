# Declarative Hermes plugins.
#
# Hermes' tool restriction is toolset-granular. `platform_toolsets.cli` takes
# toolset names, and the built-in `file` toolset is indivisible:
# [ read_file, write_file, patch, search_files ]. A reviewer profile granted
# `file` can therefore WRITE. There is no per-tool disable switch; the
# documented escape hatch is `toolsets.create_custom_toolset(name, desc,
# tools=[...])`, which takes an explicit TOOL-name list, and that is a Python
# API - reachable only from a plugin. ./hermes-plugins/least-privilege-toolsets
# is that plugin, and the profile catalog's `readonly` / `verify` toolsets do
# not exist without it.
#
# Why `extraPlugins` + `settings`, and not `hermesHomeFiles`:
#
#   * Upstream's NixOS module has a first-class `extraPlugins` option (a list
#     of packages). Its activation symlinks each as
#     `$HERMES_HOME/plugins/nix-managed-<name>` and deletes the
#     `nix-managed-*` symlinks it wrote previously, so a plugin dropped from
#     the config also leaves the directory. `hermesHomeFiles` copies files in
#     and never removes them, so a removed plugin would linger and keep
#     loading. ./hermes-profiles.nix uses `hermesHomeFiles` only because
#     upstream has no `profiles` option at all.
#
#   * Installing the directory is not enough. A `kind: standalone` user plugin
#     is opt-in: `gate_manifest` skips it with "not in plugins.enabled" unless
#     its key appears in the `plugins.enabled` allow-list. That key is the
#     manifest's `name` (not the directory name, so the `nix-managed-` prefix
#     does not matter). `plugins.enabled` is ordinary config.yaml state, which
#     the module owns through `settings` - and it has to be set here, because
#     the same module writes a `.managed` marker that makes `hermes config
#     set` and `hermes plugins enable` refuse to edit that file at runtime.
#
# So: `extraPlugins` ships the code, `settings.plugins.enabled` turns it on.
# Both are required; either alone is a silent no-op.
{
  config,
  lib,
  ...
}:
let
  inherit (lib)
    attrNames
    attrValues
    concatStringsSep
    filterAttrs
    mkIf
    mkOption
    types
    ;

  cfg = config.mine.hermes.agentPlugins;
  profileCfg = config.mine.hermes.agentProfiles;

  pluginModule =
    { config, ... }:
    {
      options = {
        enable = mkOption {
          type = types.bool;
          default = true;
          description = ''
            Whether to install this plugin and add it to `plugins.enabled`.
            false leaves it out of both, which is the whole opt-out: a plugin
            that is installed but not enabled is dead weight Hermes logs and
            skips.
          '';
        };

        package = mkOption {
          type = types.package;
          description = ''
            The plugin directory, containing plugin.yaml and __init__.py at
            its root. Built by ./hermes-plugins/package.nix, which checks that
            the manifest's `name` matches this attribute and that its `kind`
            is `standalone` - the only kind `plugins.enabled` activates.
          '';
        };

        providesToolsets = mkOption {
          type = types.listOf types.str;
          default = config.package.providesToolsets or [ ];
          defaultText = lib.literalExpression "package.passthru.providesToolsets";
          description = ''
            Custom toolset names this plugin registers. Defaults to the
            package's own `passthru.providesToolsets`. Used to reject a
            profile that asks for a toolset whose plugin is switched off,
            which Hermes itself would only report as a resolve-time warning.
          '';
        };
      };
    };

  # Plugins that will actually be installed: the per-plugin `enable` AND the
  # module-wide one. Both have to be folded in here or the assertion below
  # misses the `agentPlugins.enable = false` case.
  enabled = if cfg.enable then filterAttrs (_: p: p.enable) cfg.plugins else { };
  plugins = attrValues enabled;

  # Every custom toolset that is available given the enabled plugins.
  providedToolsets = lib.concatMap (p: p.providesToolsets) plugins;

  # Toolsets an enabled profile asks for that only a *disabled* plugin would
  # provide. Built-in names are not in any plugin's providesToolsets, so they
  # never appear here. `profileCfg.enable` is folded in because the catalog is
  # still assigned when the profiles module is switched off - the profiles
  # simply are not written, so they cannot be missing anything.
  allDeclaredToolsets = lib.concatMap (p: p.providesToolsets) (attrValues cfg.plugins);
  profileToolsets =
    if profileCfg.enable then
      lib.concatMap (p: if p.enable && p.toolsets != null then p.toolsets else [ ]) (
        attrValues profileCfg.profiles
      )
    else
      [ ];
  missingToolsets = lib.unique (
    lib.filter (t: lib.elem t allDeclaredToolsets && !(lib.elem t providedToolsets)) profileToolsets
  );
in
{
  options.mine.hermes.agentPlugins = {
    enable = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Whether to install the declared plugins into HERMES_HOME and add them
        to `plugins.enabled`. false installs none of them, which is the
        opt-out a single devbox instance gets through
        `mine.system.devboxes.<name>.hermesPlugins.enable`.

        Note that this also removes the `readonly` and `verify` toolsets the
        profile catalog uses, so the two are normally turned off together.
      '';
    };

    plugins = mkOption {
      type = types.attrsOf (types.submodule pluginModule);
      default = { };
      description = ''
        Hermes plugins, keyed by the plugin's manifest name. Each enabled
        entry is symlinked into `$HERMES_HOME/plugins/` and listed in
        `plugins.enabled` in the generated config.yaml.
      '';
    };
  };

  config = {
    # Outside the mkIf on purpose: the case this guards is precisely the one
    # where the plugin is OFF, so a `mkIf cfg.enable` would gate away the
    # assertion exactly when it is needed.
    assertions = [
      {
        assertion = missingToolsets == [ ];
        message = "mine.hermes.agentPlugins: profiles ask for toolset(s) ${concatStringsSep ", " missingToolsets}, which only a disabled plugin registers. Hermes would resolve them to no tools and the profile would silently run with nothing.";
      }
    ];

    services.hermes-agent = mkIf (enabled != { }) {
      extraPlugins = map (p: p.package) plugins;

      # `settings` is deep-merged (recursiveUpdate) across modules, and a list
      # value is replaced rather than concatenated - so this must stay the one
      # definition of plugins.enabled. Any future plugin belongs in
      # `mine.hermes.agentPlugins.plugins`, not in a second settings block.
      settings.plugins.enabled = attrNames enabled;
    };
  };
}
