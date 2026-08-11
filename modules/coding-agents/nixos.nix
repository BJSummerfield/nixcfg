{
  config,
  lib,
  pkgs,
  inputs,
  ...
}:
let
  inherit (lib)
    attrNames
    concatMap
    filterAttrs
    genAttrs
    mkIf
    mkOption
    optionals
    range
    types
    unique
    ;
  inherit (import ./options.nix lib) mkAgentOptions;
  cfg = config.mine.system.coding-agents;

  instanceNames = map (i: "agent-${toString i}") (range 1 cfg.instances);

  # The agent user matches the admin's uid 1000 (container.nix); mirror
  # the admin's group memberships too, so bind-mounted trees whose write
  # access is group-based (e.g. the NAS media-rw share) stay writable
  # inside the sandbox. Only groups with a static gid >= 1000 qualify -
  # system groups like wheel or networkmanager stay host-only.
  adminUsers = attrNames (filterAttrs (_: u: u.isSuperUser) config.mine.users);
  adminGroupNames = unique (concatMap (u: config.users.users.${u}.extraGroups) adminUsers);
  sharedGroups = filterAttrs (_: gid: gid != null && gid >= 1000) (
    genAttrs adminGroupNames (name: config.users.groups.${name}.gid or null)
  );

  # The uid the in-container agent runs as: normally the admin's pinned
  # uid (mine.users.<name>.uid), overridable per host via the option.
  agentUid =
    if cfg.agentUid != null then
      cfg.agentUid
    else if adminUsers != [ ] then
      config.users.users.${lib.head adminUsers}.uid
    else
      null;

  # Script body lives in launcher.sh; only the pool parameters and the
  # per-agent command/state mount are injected here so the shell reads as
  # plain shell. state_src is expanded by the shell at runtime, letting it
  # reference $HOME.
  mkLauncher =
    {
      name,
      cmd,
      stateSrc ? "",
      stateDest ? "",
    }:
    pkgs.writeShellScriptBin name ''
      set -euo pipefail
      instances="${toString instanceNames}"
      max_instances=${toString cfg.instances}
      agent_cmd=${cmd}
      agent_uid=${toString agentUid}
      state_src="${stateSrc}"
      state_dest="${stateDest}"
      ${builtins.readFile ./launcher.sh}
    '';

  launchers =
    # Only the sessions dir persists, not all of ~/.pi/agent: home-manager
    # owns the config files in there (settings, models, web-search, the
    # subagent tiers), and mounting over the whole dir would shadow them.
    # pi keys sessions by working directory and each project mounts at its
    # own path, so `/resume` (or `pi -r`) picks up where a crashed session
    # left off, per project.
    optionals cfg.agents.pi [
      (mkLauncher {
        name = "pi";
        cmd = "pi";
        stateSrc = "$HOME/.local/state/pi-sandbox";
        stateDest = "/home/agent/.pi/agent/sessions";
      })
    ]
    ++ optionals cfg.agents.opencode [
      (mkLauncher {
        name = "opencode";
        cmd = "opencode";
      })
    ]
    # Ephemeral containers, but claude's login/config state survives in a
    # dedicated host dir so auth happens once per machine, not per session.
    ++ optionals cfg.agents.claude [
      (mkLauncher {
        name = "claude";
        cmd = "claude";
        stateSrc = "$HOME/.local/state/claude-sandbox";
        stateDest = "/home/agent/.claude-state";
      })
    ];
in
{
  options.mine.system.coding-agents = mkAgentOptions // {
    instances = mkOption {
      type = types.ints.positive;
      default = 4;
      description = "Maximum number of concurrently running agent sessions (size of the container pool).";
    };
    agentUid = mkOption {
      type = types.nullOr types.ints.positive;
      default = null;
      description = ''
        Uid the in-container agent user runs as, matching the host user
        who launches the sandboxes so bind-mounted project files stay
        writable. Defaults to the superuser's pinned mine.users uid;
        override only if the sandboxes are run by someone else.
      '';
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = agentUid != null;
        message = "coding-agents: no agent uid available - pin mine.users.<superuser>.uid or set mine.system.coding-agents.agentUid.";
      }
    ];

    environment.systemPackages = launchers;

    containers = genAttrs instanceNames (_: {
      autoStart = false;
      # Empty root bootstrapped on every start, discarded on stop. Nothing
      # persists between sessions except the project mount, which is the
      # user's real directory anyway. Config and extensions come from the
      # store via home-manager; pi installs its npm packages at startup.
      ephemeral = true;
      # Shares the host network namespace: DNS, the tailnet (model
      # endpoint) and localhost all work with zero plumbing. The isolation
      # this container provides is filesystem/process, not network - the
      # agent is allowed full egress by design.
      privateNetwork = false;

      config = import ./container.nix {
        inherit inputs sharedGroups agentUid;
        inherit (cfg) agents;
      };
    });
  };
}
