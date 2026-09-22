# The shared Hermes agent profiles, applied by ./hermes.nix to every devbox
# instance that runs Hermes. Data only: the option surface, the defaults and
# the config.yaml/.env generation live in ./hermes-profiles.nix, and
# `mine.system.devboxes.<name>.hermesProfiles.enable = false` opts one instance
# out of the whole set.
#
# Each entry is a `mine.hermes.agentProfiles.profiles.<name>` submodule, so at
# minimum it may state `description`, `backend`, `model`, `thinking` and
# `toolsets`; everything else has a default. Adding a role here gives it to
# both containers at once - there is no per-instance profile list on purpose.
#
# ## Two families, one role set
#
# The same six roles exist twice: `claude-*` runs every role on the Anthropic
# API, `qwen-*` runs every role on the local redtruck endpoint. A family is
# picked whole, by pointing a kanban board at it; a board never mixes the two,
# because a plan written by one model and executed by the other loses the
# shared reasoning that made the plan cheap. The role semantics - description,
# toolsets, reasoning effort - are defined once below and instantiated per
# family, so the two families cannot drift apart.
#
# ## Reasoning effort
#
# Two levels only: `xhigh` for the roles that decompose or judge
# (orchestrator, verifier, reviewer, oracle) and `medium` for the roles that
# fetch or produce (scout, worker). That is not a simplification for its own
# sake - it is the only distinction the local model actually serves, since
# ../local-llm/models.nix collapses minimal/low/medium onto `medium` and
# high/xhigh/max onto `xhigh`. Declaring a level the backend does not honour
# would make this file lie about what runs.
#
# ## Toolsets are the privilege boundary
#
# Tool restriction in Hermes is toolset-granular: `platform_toolsets.cli` is
# the whole surface, and there is no way to drop one tool out of a toolset.
# The built-in `file` toolset is indivisible - read_file, write_file, patch,
# search_files - so ANY profile granted `file` can edit the tree. That single
# fact shapes every list below.
#
# `readonly` and `verify` are therefore not built-in names. They are custom
# toolsets registered by the least-privilege-toolsets plugin:
#
#   readonly = [ read_file, search_files ]
#   verify   = [ read_file, search_files, terminal, process_manage ]
#
# Without that plugin loaded, a profile asking for them gets an empty tool
# surface rather than a permissive one - Hermes ignores an unknown toolset
# name silently, and the option type does not validate it either. Fail-closed
# is the right failure here, but it is a real coupling: this catalog and that
# plugin ship together.
#
# `disabledToolsets` is a strict subtraction applied after toolsets and after
# plugins, so it is the belt to that braces: it keeps `code_execution` (whose
# sandbox has its own write_file and terminal) and `computer_use` out of every
# role that must not mutate anything, and `terminal` out of every role that
# must not run one, no matter what later enables them.
#
# Note what is deliberately NOT subtracted: `file` from the read-only roles.
# `file` and the custom read-only toolsets share `read_file`, so if the
# subtraction ever resolved tool-wise rather than toolset-wise it would strip
# reading from the very roles that exist to read. `terminal` carries no such
# overlap - nothing in `readonly` comes from it - which is why that one is
# safe to subtract and `file` is not. The grant list already withholds `file`;
# there is no need to risk it twice. The verifier keeps `terminal` off its
# subtraction list for the opposite reason: its `verify` toolset is where its
# terminal comes from.
let
  # Roles, defined once for both families. `model` and `backend` are the only
  # per-family fields; everything here is the role itself.
  roles = {
    orchestrator = {
      description = ''
        Decomposes a goal into ordered, independently checkable cards and dispatches them to the other profiles, tracking what is done and what is blocked. Reads the tree and the board; cannot edit a file or run a command, so work it wants done must be routed, not performed. Send planning, breakdown, re-planning and triage here - never implementation.
      '';
      thinking = "xhigh";
      toolsets = [
        "readonly"
        "kanban"
        "delegation"
        "todo"
        "skills"
        "clarify"
      ];
      disabledToolsets = [
        "terminal"
        "code_execution"
        "computer_use"
      ];
    };

    scout = {
      description = ''
        Gathers context read-only and returns a condensed brief: which files a task touches, where the call sites and prior art are, what the existing conventions look like, each with a path and line number. Cheap and fast, with a short output budget - send it "where is X", "how does Y work", "what already does Z" before committing a worker to a plan.
      '';
      thinking = "medium";
      toolsets = [
        "readonly"
        "web"
        "skills"
      ];
      disabledToolsets = [
        "terminal"
        "code_execution"
        "computer_use"
      ];
    };

    worker = {
      description = ''
        Implements. The only profile that can edit files and run commands: it writes the change, runs the build, tests and formatter it touches, and reports the diff plus the command output. Give it one bounded, concrete brief with the acceptance check already stated - it is not the place to decide what should be built.
      '';
      thinking = "medium";
      toolsets = [
        "file"
        "terminal"
        "kanban"
        "todo"
        "skills"
        "web"
      ];
      disabledToolsets = [ "computer_use" ];
    };

    verifier = {
      description = ''
        Independently verifies a finished change: checks it out, builds it, runs the tests, lints and reproduces the reported behaviour, then reports pass or fail with the actual command output. Has a terminal but no write tools, so it cannot quietly edit a failing test into passing - a red result stays red. This is the profile for a kanban review lane, whose forced sdlc-review skill verifies by building and running.
      '';
      thinking = "xhigh";
      toolsets = [
        "verify"
        "kanban"
        "skills"
      ];
      disabledToolsets = [
        "code_execution"
        "computer_use"
      ];
    };

    reviewer = {
      description = ''
        Judges a change against its stated intent by reading alone - design fit, missed cases, risk, house rules - and returns a verdict with file:line evidence. No terminal and no write tools at all, which is the point: it reasons about whether the right thing was built, and cannot be drawn into proving it by running it. Route "does this do what the plan said" here and "does this actually pass" to the verifier.
      '';
      thinking = "xhigh";
      toolsets = [
        "readonly"
        "kanban"
        "skills"
      ];
      disabledToolsets = [
        "terminal"
        "code_execution"
        "computer_use"
      ];
    };

    # Earns a slot next to reviewer because it answers a different question.
    # reviewer judges finished work against a plan; oracle is what a blocked
    # worker escalates to mid-task, before there is anything to review. The pi
    # role vocabulary in ../pi-coding-agent/settings.nix already carries the
    # same split, and folding the two together would either give the reviewer
    # open-ended research or send design questions to a profile that expects a
    # diff.
    oracle = {
      description = ''
        Answers one hard, self-contained question at maximum reasoning effort and read-only: a design trade-off, an unfamiliar API's real contract, a root-cause hypothesis for a failure someone else reproduced. Returns the argument and the evidence behind it, not a change. Escalation target for a blocked worker; it is not a place to send work.
      '';
      thinking = "xhigh";
      toolsets = [
        "readonly"
        "web"
        "skills"
      ];
      disabledToolsets = [
        "terminal"
        "code_execution"
        "computer_use"
      ];
    };
  };

  # Anthropic ids are not validated against any catalog, here or in
  # ./hermes-profiles.nix - a stale id fails at the first API call, not at
  # build time. Opus for the roles whose output is the deliverable, Sonnet for
  # the two whose value is turnaround. Haiku is deliberately absent: it does
  # not support reasoning_effort, and every profile here writes one.
  claudeModels = {
    orchestrator = "claude-opus-5";
    scout = "claude-sonnet-5";
    worker = "claude-opus-5";
    verifier = "claude-sonnet-5";
    reviewer = "claude-opus-5";
    oracle = "claude-opus-5";
  };

  # One set of weights, three ids: the aliases in ../local-llm/models.nix
  # differ only in max output tokens, and the context window is 98304 either
  # way. Reasoning and answer share that output budget, so a role at `xhigh`
  # needs the 32k alias even when its answer is short - otherwise it can spend
  # the whole budget thinking and return nothing. scout is the one role that
  # is both `medium` and deliberately terse, so it takes the 8k alias and is
  # cut off rather than allowed to ramble.
  qwenModels = {
    orchestrator = "Qwen3.8-27B-NVFP4-32k";
    scout = "Qwen3.8-27B-NVFP4-8k";
    worker = "Qwen3.8-27B-NVFP4-32k";
    verifier = "Qwen3.8-27B-NVFP4-32k";
    reviewer = "Qwen3.8-27B-NVFP4-32k";
    oracle = "Qwen3.8-27B-NVFP4-32k";
  };

  # The description is what a decomposer reads when choosing where a card
  # goes, and both families expose the same six role names, so each one has to
  # say which model it spends.
  #
  # This file is `import`ed as plain data by ./hermes.nix - no `lib` in scope -
  # hence the hand-rolled trim, which strips the leading and trailing
  # whitespace an indented '' string carries.
  trim = s: builtins.head (builtins.match "[[:space:]]*(.*[^[:space:]])[[:space:]]*" s);

  mkFamily =
    {
      prefix,
      backend,
      models,
      note,
    }:
    builtins.listToAttrs (
      map (role: {
        name = "${prefix}-${role}";
        value = roles.${role} // {
          inherit backend;
          model = models.${role};
          description = "${trim roles.${role}.description} ${note}";
        };
      }) (builtins.attrNames roles)
    );
in
mkFamily {
  prefix = "claude";
  backend = "anthropic";
  models = claudeModels;
  note = "Runs on Anthropic Claude: strongest reasoning, metered per token.";
}
// mkFamily {
  prefix = "qwen";
  backend = "local";
  models = qwenModels;
  note = "Runs on the local Qwen endpoint: free and private, 98k context, weaker on long chains.";
}
