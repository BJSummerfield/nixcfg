# NixOS configuration shared by every instance in the agent container
# pool. Imported per-instance by nixos.nix; `inputs` is the host flake's
# inputs, `agents` the per-agent toggles from the host's options,
# `sharedGroups` the admin's static-gid groups (name -> gid) mirrored in
# so group-permissioned bind mounts stay writable, `agentUid` the uid of
# the host user who runs the sandboxes.
{
  inputs,
  agents,
  sharedGroups,
  agentUid,
}:
{ pkgs, lib, ... }:
{
  imports = [
    inputs.home-manager.nixosModules.home-manager
    ../unfree/nixos.nix
  ];

  # Match host uid for writable bind-mounts and group-permissioned shares.
  # Host nix-daemon socket makes the agent a trusted user — same exposure as the old pi-sandbox.
  users.users.agent = {
    isNormalUser = true;
    uid = agentUid;
    description = "coding agent";
    extraGroups = lib.attrNames sharedGroups;
  };
  # No user namespacing on these containers, so matching gids here means
  # matching permissions on the host filesystem.
  users.groups = lib.mapAttrs (_: gid: { inherit gid; }) sharedGroups;

  # nix builds go through the host daemon; the store is shared
  # read-only. Pin the registry so `nix shell nixpkgs#foo` resolves
  # to the host's nixpkgs instantly instead of fetching unstable.
  nix.settings.experimental-features = [
    "nix-command"
    "flakes"
  ];
  nix.registry.nixpkgs.flake = inputs.nixpkgs;
  nix.nixPath = [ "nixpkgs=flake:nixpkgs" ];

  # Declared the way every other module declares its unfree needs; the
  # imported unfree module turns mine.allowedUnfree into the predicate.
  # Conditional on the toggle, unlike the hardcoded list this replaces.
  mine.allowedUnfree = lib.optionals agents.claude [ "claude-code" ];

  environment.systemPackages =
    with pkgs;
    [
      curl
      fd
      jq
      ripgrep
    ]
    ++ lib.optionals agents.claude [ claude-code ];

  # Claude keeps its login/config in the state dir the launcher
  # bind-mounts from the host; the nix-store binary can't self-update.
  environment.sessionVariables = {
    CLAUDE_CONFIG_DIR = "/home/agent/.claude-state";
    DISABLE_AUTOUPDATER = "1";
  };

  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    users.agent = {
      imports = [
        ../opencode/home.nix
        ../pi-coding-agent/home.nix
      ];
      home.stateVersion = "26.05";

      # No pi-sandbox in here: the container is the boundary.
      mine.user.opencode.enable = agents.opencode;
      mine.user.pi-coding-agent.enable = agents.pi;

      # Unsigned commits: the signing key stays on the host.
      programs.git = {
        enable = true;
        settings.user = {
          name = "BJSummerfield";
          email = "brianjsummerfield@gmail.com";
        };
      };

      home.file.".pi/agent/APPEND_SYSTEM.md".source = ../pi-coding-agent/APPEND_SYSTEM.md;
    };
  };

  system.stateVersion = "26.05";
}
