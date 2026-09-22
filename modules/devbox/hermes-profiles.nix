{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib)
    attrValues
    concatStringsSep
    filterAttrs
    foldl'
    mapAttrs
    mapAttrsToList
    mkIf
    mkOption
    optionalAttrs
    recursiveUpdate
    types
    ;

  llm = import ../local-llm/models.nix;
  cfg = config.mine.hermes.agentProfiles;
  yaml = pkgs.formats.yaml { };

  rootSettings = config.services.hermes-agent.settings;

  inherited = foldl' (
    acc: path:
    if lib.hasAttrByPath path rootSettings then
      recursiveUpdate acc (lib.setAttrByPath path (lib.getAttrFromPath path rootSettings))
    else
      acc
  ) { } cfg.inheritFromRoot;

  unclassified = lib.subtractLists (map lib.head cfg.inheritFromRoot ++ cfg.rootKeysNotInherited) (
    lib.attrNames rootSettings
  );

  effortLevels = [
    "none"
    "minimal"
    "low"
    "medium"
    "high"
    "xhigh"
    "max"
    "ultra"
  ];

  localModels =
    let
      entriesFor =
        id: m:
        {
          ${id} = {
            base = m;
            alias = null;
          };
        }
        // mapAttrs (_: a: {
          base = m;
          alias = a;
        }) (m.aliases or { });
    in
    foldl' (acc: id: acc // entriesFor id llm.models.${id}) { } (lib.attrNames llm.models);

  localContextLength =
    id:
    let
      e = localModels.${id} or null;
    in
    if e == null then
      null
    else if e.alias != null then
      e.alias.contextWindow
    else
      e.base.maxModelLen - e.base.headroom;

  localEffort =
    id: level:
    let
      e = localModels.${id} or null;
    in
    if e == null || level == "none" then level else e.base.thinkingLevels.${level} or level;

  modelIdOf =
    p:
    if p.model != null then
      p.model
    else if p.backend == "local" then
      llm.default
    else
      null;

  configOf =
    p:
    let
      id = modelIdOf p;
      isLocal = p.backend == "local";
      ctx =
        if p.contextLength != null then
          p.contextLength
        else if isLocal then
          localContextLength id
        else
          null;
      effort = if isLocal && p.mapThinking then localEffort id p.thinking else p.thinking;

      generated = {
        model = {
          provider = if isLocal then "custom" else p.backend;
          default = id;
        }
        // optionalAttrs isLocal {
          base_url = llm.baseUrl;
          api_key = "local";
        }
        // optionalAttrs (ctx != null) { context_length = ctx; };

        agent = {
          reasoning_effort = effort;
        }
        // optionalAttrs (p.disabledToolsets != [ ]) { disabled_toolsets = p.disabledToolsets; };
      }
      // optionalAttrs (p.toolsets != null) { platform_toolsets.cli = p.toolsets; };
    in
    recursiveUpdate (recursiveUpdate inherited generated) p.settings;

  envOf =
    p:
    optionalAttrs (p.backend == "anthropic") { CLAUDE_CONFIG_DIR = cfg.claudeConfigDir; }
    // p.environment;

  envText = env: concatStringsSep "\n" (mapAttrsToList (k: v: "${k}=${v}") env) + "\n";

  filesOf =
    p:
    let
      env = envOf p;
      dir = "profiles/${p.name}";
    in
    {
      "${dir}/config.yaml" = yaml.generate "hermes-profile-${p.name}.yaml" (configOf p);
    }
    // optionalAttrs (env != { }) { "${dir}/.env" = envText env; }
    // optionalAttrs (p.description != null) {
      "${dir}/profile.yaml" = yaml.generate "hermes-profile-${p.name}-meta.yaml" {
        inherit (p) description;
        description_auto = false;
      };
    };

  profileModule =
    { name, ... }:
    {
      options = {
        enable = mkOption {
          type = types.bool;
          default = true;
          description = ''
            Whether to write this profile. false leaves any existing directory
            alone: activation installs files, it does not prune.
          '';
        };

        name = mkOption {
          type = types.str;
          default = name;
          description = ''
            Directory name under `$HERMES_HOME/profiles/` and the id
            `hermes --profile <name>` takes. Two profiles must not resolve to
            the same name.
          '';
          example = "claude-reviewer";
        };

        description = mkOption {
          type = types.nullOr types.str;
          default = null;
          description = ''
            One-line summary written to `profile.yaml`, shown by
            `hermes profile list` and read by the kanban decomposer. null
            writes no profile.yaml.
          '';
          example = "Reviews diffs. Read-only toolset, high reasoning effort.";
        };

        backend = mkOption {
          type = types.enum [
            "local"
            "anthropic"
          ];
          default = "local";
          description = ''
            `local` is the endpoint from ../local-llm/models.nix, which also
            supplies the default model and the derived context length.
            `anthropic` is the Claude API, authenticated by the Claude Code
            OAuth file under `claudeConfigDir`, and requires `model`.
          '';
        };

        model = mkOption {
          type = types.nullOr types.str;
          default = null;
          description = ''
            Model id for `model.default`. null takes the backend's house
            default, which exists only for `local` (`${llm.default}`). A
            `local` id must name an entry in ../local-llm/models.nix, alias
            ids included.
          '';
          example = "Qwen3.8-27B-NVFP4-32k";
        };

        contextLength = mkOption {
          type = types.nullOr types.ints.positive;
          default = null;
          description = ''
            `model.context_length` in tokens. null derives it for a `local`
            model and omits the key for any other backend.
          '';
          example = 98304;
        };

        thinking = mkOption {
          type = types.enum effortLevels;
          default = "medium";
          description = ''
            `agent.reasoning_effort`. On a `local` model this is the requested
            level, which `mapThinking` collapses onto one the model serves.
          '';
        };

        mapThinking = mkOption {
          type = types.bool;
          default = true;
          description = ''
            Whether to send `thinking` through the model's `thinkingLevels`
            map from ../local-llm/models.nix. `local` backends only; false
            writes the level verbatim.
          '';
        };

        toolsets = mkOption {
          type = types.nullOr (types.listOf types.str);
          default = null;
          description = ''
            Toolset names for `platform_toolsets.cli`. This REPLACES the list,
            so it is the whole tool surface; null omits the key and inherits
            the default profile's.
          '';
          example = [
            "file"
            "skills"
          ];
        };

        disabledToolsets = mkOption {
          type = types.listOf types.str;
          default = [ ];
          description = ''
            `agent.disabled_toolsets`: a strict subtraction applied after
            `toolsets` and after plugins, so it keeps a capability out no
            matter what enables it. Empty omits the key.
          '';
          example = [ "browser" ];
        };

        settings = mkOption {
          inherit (yaml) type;
          default = { };
          description = ''
            Extra config.yaml keys, deep-merged OVER the generated ones.
            Prefer the typed options: a key set here silently wins over them.
          '';
          example = {
            compression = {
              enabled = true;
              threshold = 0.85;
            };
          };
        };

        environment = mkOption {
          type = types.attrsOf types.str;
          default = { };
          description = ''
            Variables written to the profile's `.env`. An `anthropic` profile
            gets CLAUDE_CONFIG_DIR automatically; an entry of the same name
            overrides it.

            CAUTION: this lands in the world-readable Nix store. Secrets belong
            in `services.hermes-agent.environmentFiles`.
          '';
          example = {
            HERMES_DISABLE_TELEMETRY = "1";
          };
        };
      };
    };

  enabled = filterAttrs (_: p: p.enable) cfg.profiles;
  profiles = attrValues enabled;
  names = map (p: p.name) profiles;

  hermes = config.services.hermes-agent;
  # nixosModules.nix:50. Not an option, so it is recomputed rather than read.
  hermesHome = "${hermes.stateDir}/.hermes";
  owner = "${hermes.user}:${hermes.group}";
  profilesRoot = "${hermesHome}/profiles";

  # moduleCommon.nix:1135. Upstream makes these for the root home only:
  # mkStateScript takes stateDirs hardcoded to this list (nixosModules.nix:488),
  # so no option asks upstream to repeat it one level down.
  stateSubdirs = [
    "cron"
    "sessions"
    "logs"
    "memories"
    "plugins"
  ];

  # Parents first: the shell loop below makes them in order.
  profileStateDirs = [
    profilesRoot
  ]
  ++ lib.concatMap (p: [ "${profilesRoot}/${p.name}" ]) profiles
  ++ lib.concatMap (p: map (d: "${profilesRoot}/${p.name}/${d}") stateSubdirs) profiles;
in
{
  options.mine.hermes.agentProfiles = {
    enable = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Whether to materialize `profiles` into HERMES_HOME. false writes no
        profile files at all.
      '';
    };

    inheritFromRoot = mkOption {
      type = types.listOf (types.listOf types.str);
      default = [
        [
          "plugins"
          "enabled"
        ]
        [
          "plugins"
          "disabled"
        ]
        [
          "terminal"
          "cwd"
        ]
      ];
      description = ''
        Attribute paths copied from `services.hermes-agent.settings` into every
        generated profile's config.yaml, weakest in the merge: a generated key
        or `settings` always wins.

        A profile is its own complete HERMES_HOME, not an overlay - Hermes
        merges it over upstream defaults alone, so anything absent here falls
        back to the upstream default rather than to the root's value. Paths are
        leaves, not subtrees, because a subtree drags identity-bearing siblings
        along with the key that was wanted.
      '';
      example = [
        [ "compression" ]
      ];
    };

    rootKeysNotInherited = mkOption {
      type = types.listOf types.str;
      default = [
        "model"
        "dashboard"
        "platforms"
        "gateway"
        "multiplex_profiles"
        "profile_routes"
      ];
      description = ''
        Top-level `services.hermes-agent.settings` keys deliberately withheld
        from profiles, either because the generator writes its own or because
        copying one identity across profiles collides. Listing a key here is
        how an operator records that decision; a root key that is in neither
        this nor `inheritFromRoot` fails evaluation.
      '';
    };

    claudeConfigDir = mkOption {
      type = types.str;
      default = "/home/agent/.claude-state";
      description = ''
        CLAUDE_CONFIG_DIR for `anthropic` profiles: the directory holding the
        Claude Code OAuth credentials. Must match what the container puts
        there - nothing else supplies an Anthropic credential.
      '';
    };

    profiles = mkOption {
      type = types.attrsOf (types.submodule profileModule);
      default = { };
      description = ''
        Hermes agent profiles, keyed by profile name. Each becomes a
        `$HERMES_HOME/profiles/<name>/` directory with a generated config.yaml,
        plus a .env and a profile.yaml where the profile needs them.
      '';
      example = lib.literalExpression ''
        {
          reviewer = {
            description = "Reviews diffs against the house rules.";
            model = "Qwen3.8-27B-NVFP4-32k";
            thinking = "xhigh";
            toolsets = [ "file" "skills" ];
          };
          planner = {
            backend = "anthropic";
            model = "claude-opus-4-6";
            thinking = "high";
          };
        }
      '';
    };
  };

  config = mkIf (cfg.enable && enabled != { }) {
    assertions = [
      {
        assertion = unclassified == [ ];
        message = "mine.hermes.agentProfiles: services.hermes-agent.settings has unclassified top-level key(s) ${concatStringsSep ", " unclassified}. A profile is its own HERMES_HOME, so each key is either copied in (add a path to inheritFromRoot) or deliberately withheld (add it to rootKeysNotInherited); leaving it unlisted silently gives profiles the upstream default.";
      }
      {
        assertion = lib.length (lib.unique names) == lib.length names;
        message = "mine.hermes.agentProfiles: two profiles resolve to the same name (${concatStringsSep ", " names}); each writes to profiles/<name>/, so one would overwrite the other.";
      }
    ]
    ++ map (p: {
      assertion = builtins.match "[A-Za-z0-9][A-Za-z0-9_-]*" p.name != null;
      message = "mine.hermes.agentProfiles.profiles.${p.name}: name must be alphanumerics, '-' and '_' - it is a directory name and a CLI argument.";
    }) profiles
    ++ map (p: {
      assertion = modelIdOf p != null;
      message = "mine.hermes.agentProfiles.profiles.${p.name}: backend \"${p.backend}\" has no house default model, so `model` must be set.";
    }) profiles
    ++ map (p: {
      assertion = p.backend != "local" || localModels ? ${modelIdOf p};
      message = "mine.hermes.agentProfiles.profiles.${p.name}: model \"${toString (modelIdOf p)}\" is not in modules/local-llm/models.nix (known: ${concatStringsSep ", " (lib.attrNames localModels)}).";
    }) profiles;

    services.hermes-agent.hermesHomeFiles = foldl' (acc: p: acc // filesOf p) { } profiles;

    # A profile directory is its own complete HERMES_HOME, and in managed mode
    # Hermes refuses to build one: config_home.py:64 calls _ensure_directory with
    # create=not managed, which raises HomeInitializationError on a missing
    # cron/sessions/logs/memories instead of creating it. Upstream makes those
    # for the root home only (nixosModules.nix:475), and hermesHomeFiles'
    # `install -D` leaves every profile parent root-owned 0755 - so the service
    # user could not write the SOUL.md that config_home.py:67 emits either.
    #
    # Ordered, not racing: deps on the upstream activation script by its real
    # attribute name, so it runs after the profile files exist and after
    # mkStateScript has created their parents with the wrong owner.
    system.activationScripts.hermes-agent-profile-state = lib.stringAfter [ "hermes-agent-setup" ] ''
      for _dir in ${lib.escapeShellArgs profileStateDirs}; do
        mkdir -p "$_dir"
        chown ${owner} "$_dir"
        chmod 2770 "$_dir"
      done
    '';
  };
}
