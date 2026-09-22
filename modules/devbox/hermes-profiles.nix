# Declarative Hermes agent profiles.
#
# A Hermes profile is a directory under $HERMES_HOME/profiles/<name>/ holding
# its own config.yaml (model, reasoning effort, toolsets), an optional .env and
# an optional profile.yaml (metadata). Upstream's NixOS module has no `profiles`
# option, so this module renders the profile data to files and hands them to
# `services.hermes-agent.hermesHomeFiles`, whose activation installs every key
# under HERMES_HOME, making the intermediate directories.
#
# These files are written from the Nix store on each activation, so a runtime
# edit of a declared profile's config.yaml does not survive a rebuild. That is
# the same contract the module already applies to the default profile's
# config.yaml, and the `.managed` marker it writes is what makes
# `hermes config set` refuse to edit it in the first place.
#
# The profile data itself lives in ./hermes-profiles-catalog.nix and is applied
# by ./hermes.nix, so every devbox instance that runs Hermes gets the same set.
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

  # Hermes' agent.reasoning_effort scale, lowest to highest.
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

  # Every model id the local catalog serves - base ids and alias ids alike -
  # mapped to the base entry plus the alias entry when the id is an alias. An
  # alias carries its own contextWindow; everything else comes from the base.
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

  # null rather than a throw for an unknown id: the assertions below name the
  # bad id, and a throw here would fire first and bury it.
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

  # The local model advertises more effort levels than it actually serves, and
  # models.nix states the collapse (minimal/low/medium -> medium, the rest ->
  # xhigh). Mapping here keeps a role's declared intent readable while sending
  # the backend a level it honours.
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

  # The generated config.yaml body for one profile, before `settings` is
  # merged over it. Keys that Hermes should inherit from the default profile
  # are omitted rather than written as null.
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
    in
    recursiveUpdate (
      {
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
      // optionalAttrs (p.toolsets != null) { platform_toolsets.cli = p.toolsets; }
    ) p.settings;

  # Anthropic auth on these boxes is the Claude Code OAuth file, which Hermes
  # finds through CLAUDE_CONFIG_DIR. There is no ANTHROPIC_API_KEY, so a
  # profile pointed at anthropic that does not export this reaches no
  # credentials at all.
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
      # profile.yaml is metadata ABOUT the profile - `hermes profile list` and
      # the kanban decomposer read `description` from it - and is deliberately
      # separate from config.yaml.
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
            Whether to write this profile. false leaves the directory alone
            rather than removing it: activation installs files, it does not
            prune a profile that went away.
          '';
        };

        name = mkOption {
          type = types.str;
          default = name;
          description = ''
            Directory name under `$HERMES_HOME/profiles/`, and the id
            `hermes --profile <name>` takes. Defaults to the attribute name.
            Set it only to give a profile a directory name that differs from
            its key here; two profiles must not resolve to the same name.
          '';
          example = "claude-reviewer";
        };

        description = mkOption {
          type = types.nullOr types.str;
          default = null;
          description = ''
            One-line summary of what this profile is for, written to the
            profile's `profile.yaml`. `hermes profile list` and the kanban
            decomposer show it; null writes no profile.yaml, and Hermes then
            falls back to the bare name.
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
            Which model backend the profile talks to.

            `local` is the redtruck vLLM/ninfer endpoint from
            ../local-llm/models.nix: provider `custom`, its base URL, and the
            placeholder api_key the endpoint ignores. `model` then defaults to
            the catalog default and `contextLength` is derived from the
            catalog entry.

            `anthropic` is the Claude API, authenticated by the Claude Code
            OAuth file under `claudeConfigDir` - these boxes hold no
            ANTHROPIC_API_KEY. `model` is mandatory for it, since the local
            catalog's default is meaningless there.
          '';
        };

        model = mkOption {
          type = types.nullOr types.str;
          default = null;
          description = ''
            Model id for `model.default`. null means the house default for the
            backend, which exists only for `local` (`${llm.default}`); a
            null model on `anthropic` is an error.

            For `local` the id must name an entry in ../local-llm/models.nix,
            alias ids included - an alias is how a role picks a shorter output
            budget off the same weights.
          '';
          example = "Qwen3.8-27B-NVFP4-32k";
        };

        contextLength = mkOption {
          type = types.nullOr types.ints.positive;
          default = null;
          description = ''
            `model.context_length` in tokens. null derives it for a `local`
            model - the alias' contextWindow, or maxModelLen minus headroom -
            and omits the key entirely for any other backend, leaving Hermes'
            own default.
          '';
          example = 98304;
        };

        thinking = mkOption {
          type = types.enum effortLevels;
          default = "medium";
          description = ''
            `agent.reasoning_effort` for the profile. On a `local` model this
            is the requested level, which `mapThinking` collapses onto a level
            the model actually serves.
          '';
        };

        mapThinking = mkOption {
          type = types.bool;
          default = true;
          description = ''
            Whether to send `thinking` through the model's `thinkingLevels`
            map from ../local-llm/models.nix before writing it. Only applies to
            `backend = "local"`, and only to a model that declares such a map;
            false writes the level verbatim.
          '';
        };

        toolsets = mkOption {
          type = types.nullOr (types.listOf types.str);
          default = null;
          description = ''
            Toolset names for `platform_toolsets.cli`, the tool surface the
            profile gets on the CLI platform. This REPLACES the list, so it is
            the whole surface, not an addition to a default. null omits the
            key and inherits whatever the default profile has.

            Names are Hermes toolsets, e.g. `file`, `terminal`, `web`,
            `browser`, `skills`, `vision`.
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
            `agent.disabled_toolsets`: a strict subtraction applied at the end
            of tool resolution, after `toolsets` and after plugins. Use it to
            keep a capability out no matter what enables it. Empty omits the
            key.
          '';
          example = [ "browser" ];
        };

        settings = mkOption {
          inherit (yaml) type;
          default = { };
          description = ''
            Extra config.yaml keys for this profile, deep-merged OVER the
            generated ones. The escape hatch for anything this module does not
            model; prefer the typed options where they exist, because a key
            set here silently wins over them.
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
            Variables written to the profile's `.env`, which Hermes loads when
            the profile is active. An `anthropic` profile gets CLAUDE_CONFIG_DIR
            here automatically; an entry of the same name overrides it.

            CAUTION: this lands in the Nix store, which every user can read.
            Secrets belong in `services.hermes-agent.environmentFiles`.
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
in
{
  options.mine.hermes.agentProfiles = {
    enable = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Whether to materialize `profiles` into HERMES_HOME. false writes no
        profile files at all, which is the opt-out a single devbox instance
        gets through `mine.system.devboxes.<name>.hermesProfiles.enable`.
      '';
    };

    claudeConfigDir = mkOption {
      type = types.str;
      default = "/home/agent/.claude-state";
      description = ''
        CLAUDE_CONFIG_DIR for profiles on the `anthropic` backend: the
        directory holding the Claude Code OAuth credentials Hermes
        authenticates with. Must match what the container puts there, since
        nothing else on these boxes supplies an Anthropic credential.
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
  };
}
