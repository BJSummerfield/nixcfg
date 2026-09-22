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
            Both are required: an installed plugin with no allow-list entry is
            skipped, and an entry with no directory matches nothing.
          '';
        };

        package = mkOption {
          type = types.package;
          description = ''
            The plugin directory, containing plugin.yaml and __init__.py at
            its root. Built by ./hermes-plugins/package.nix.
          '';
        };

        providesToolsets = mkOption {
          type = types.listOf types.str;
          default = config.package.providesToolsets or [ ];
          defaultText = lib.literalExpression "package.passthru.providesToolsets";
          description = ''
            Custom toolset names this plugin registers. Used to reject a
            profile that asks for a toolset whose plugin is switched off,
            which Hermes itself would only report as a resolve-time warning.
          '';
        };
      };
    };

  enabled = if cfg.enable then filterAttrs (_: p: p.enable) cfg.plugins else { };
  plugins = attrValues enabled;

  # Every profile is its own HERMES_HOME, and discovery only ever scans
  # `<home>/plugins`, so the root install is invisible to `hermes -p <name>`.
  profileNames =
    if profileCfg.enable then
      map (p: p.name) (attrValues (filterAttrs (_: p: p.enable) profileCfg.profiles))
    else
      [ ];

  pluginFiles =
    profile: name: p:
    let
      src = p.package.pluginSrc;
    in
    lib.mapAttrs' (f: _: lib.nameValuePair "profiles/${profile}/plugins/${name}/${f}" (src + "/${f}")) (
      filterAttrs (_: t: t == "regular") (builtins.readDir src)
    );

  profilePluginFiles = lib.foldl' lib.mergeAttrs { } (
    lib.concatMap (profile: lib.mapAttrsToList (pluginFiles profile) enabled) profileNames
  );

  providedToolsets = lib.concatMap (p: p.providesToolsets) plugins;
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
        to `plugins.enabled`. false also removes the `readonly` and `verify`
        toolsets the profile catalog uses, so the two are normally turned off
        together.
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
    # Outside the mkIf: the case this guards is the one where the plugin is off.
    assertions = [
      {
        assertion = missingToolsets == [ ];
        message = "mine.hermes.agentPlugins: profiles ask for toolset(s) ${concatStringsSep ", " missingToolsets}, which only a disabled plugin registers. Hermes would resolve them to no tools and the profile would silently run with nothing.";
      }
    ];

    services.hermes-agent = mkIf (enabled != { }) {
      extraPlugins = map (p: p.package) plugins;
      hermesHomeFiles = profilePluginFiles;

      # `settings` deep-merges across modules but replaces lists, so this must
      # stay the only definition of plugins.enabled.
      settings.plugins.enabled = attrNames enabled;
    };
  };
}
