let
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

    reader = {
      description = ''
        Reads and answers, read-only. Two jobs: it gathers context and returns a condensed brief - which files a task touches, where the call sites and prior art are, what the existing conventions look like, each with a path and line number; and it answers one hard, self-contained question - a design trade-off, an unfamiliar API's real contract, a root-cause hypothesis for a failure someone else reproduced - returning the argument and the evidence behind it. Send it "where is X", "how does Y work", "what already does Z" before committing a worker to a plan, and use it as the escalation target for a blocked worker. It returns findings, never a change; raise the card's reasoning effort for the hard-question case.
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
  };

  claudeModels = {
    orchestrator = "claude-opus-5";
    reader = "claude-sonnet-5";
    worker = "claude-opus-5";
    verifier = "claude-sonnet-5";
    reviewer = "claude-opus-5";
  };

  qwenModel = "Qwen3.8-27B-NVFP4";

  # Hand-rolled: ./hermes.nix imports this file as plain data, so there is no lib in scope.
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
  models = builtins.mapAttrs (_: _: qwenModel) roles;
  note = "Runs on the local Qwen endpoint: free and private, 98k context, weaker on long chains.";
}
