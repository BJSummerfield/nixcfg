# Home-manager profile for the devbox container's agent user.
{
  gitIdentity,
  signCommits,
  agentPkgs,
  claudeSettings,
  envContract,
}:
{ lib, ... }:
{
  imports = [
    ../direnv/home.nix
    ../pi-coding-agent/home.nix
  ];
  home.stateVersion = "26.05";

  mine.user = {
    direnv.enable = true;
    pi-coding-agent.enable = true;
  };

  # Suppresses the upstream module's own bin/pi - otherwise it
  # collides with the mkAgent wrapper of the same name in this same
  # home-manager profile (pkgs.buildEnv fails hard on same-name
  # paths of equal priority). Settings/config generation from the
  # module is untouched; only the package is disabled.
  programs.pi-coding-agent.package = null;

  # Paseo creates worktrees under its dataDir, so per-repo `direnv allow`
  # can never cover them. Whitelisting both trees — agent runs arbitrary
  # code by design, and the container is the boundary.
  programs.direnv.config.whitelist.prefix = [
    "/home/agent/projects"
    "/var/lib/paseo/worktrees"
  ];

  home.packages = agentPkgs;
  home.file.".pi/agent/APPEND_SYSTEM.md".source = envContract;

  # git signs via `ssh-keygen -Y sign`, which takes a key file, not an
  # agent — so these settings are the whole mechanism. All three are
  # gated on signCommits as one unit: gpgSign left on without a key
  # present makes git refuse to commit at all, which is worse than an
  # instance that simply does not sign.
  programs.git = {
    enable = true;
    settings = {
      user = {
        inherit (gitIdentity) name email;
      }
      // lib.optionalAttrs signCommits {
        signingkey = "/run/secrets/signing-key";
      };
      # Reads the token at use time so it never lands in a config file
      # or the nix store. The token bounds which repos are reachable;
      # a GitHub ruleset is what stops a push to a protected branch.
      credential."https://github.com".helper =
        "!f() { echo username=x-access-token; echo password=$(cat /run/secrets/github-token); }; f";
    }
    // lib.optionalAttrs signCommits {
      gpg.format = "ssh";
      commit.gpgSign = true;
    };
  };

  # Copied, not linked: Claude rewrites settings.json (theme changes,
  # plugin toggles), and a store symlink would make that write fail
  # with EROFS. `rm` before `install` because install(1) follows an
  # existing symlink to its read-only target - and because the file
  # already exists unmanaged in every running container.
  #
  # This also means anything Claude itself writes to settings.json is
  # reset on the next activation: a theme change, a plugin toggle, and
  # - the one that actually changes behaviour - any user-scope
  # `permissions` rules, which live in this same file and are silently
  # discarded with it. An allow/deny rule added mid-session survives
  # only until the next rebuild; put anything durable in a project's
  # own .claude/settings.json instead.
  # That is deliberate, not a gap to close: a container must never
  # come up with a plugin enabled - or a permission granted - that
  # this config did not ask for.
  home.activation.claudeSettings = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
    run mkdir -p $VERBOSE_ARG "$HOME/.claude-state"
    run rm -f $VERBOSE_ARG "$HOME/.claude-state/settings.json"
    run install $VERBOSE_ARG -m 0644 ${claudeSettings} \
      "$HOME/.claude-state/settings.json"
  '';
}
