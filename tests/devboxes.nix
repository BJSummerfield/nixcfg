# Pure-evaluation checks for the multi-instance devbox module. No VM here on
# purpose: everything this refactor can break is a value derived from an
# instance's attribute name, and all of those are visible at eval time. The
# parts a VM could uniquely prove — that the tailnet join works, that
# `tailscale serve` publishes — are the manual steps the module deliberately
# keeps out of Nix.
{
  nixpkgs,
  inputs,
  system,
}:
let
  inherit (nixpkgs) lib;
  pkgs = nixpkgs.legacyPackages.${system};

  # Only the two modules under test, plus the minimum NixOS needs to evaluate.
  # Deliberately not modules/nixos.nix: importing the whole module set would
  # make this check slow and couple it to modules it is not testing.
  host =
    (lib.nixosSystem {
      specialArgs = { inherit inputs; };
      modules = [
        # modules/system/nixos.nix sets sops.age.sshKeyPaths, so its option
        # tree has to be present even though nothing here decrypts anything.
        inputs.sops-nix.nixosModules.sops
        ../modules/system/nixos.nix
        ../modules/devbox/nixos.nix
        {
          nixpkgs.hostPlatform = system;
          fileSystems."/" = {
            device = "/dev/null";
            fsType = "ext4";
          };

          mine.system = {
            hostName = "devbox-test";
            externalInterface = "eth0";

            devboxes = {
              # Left at the default gitIdentity, to prove the default reaches
              # the container.
              devbox = {
                githubTokenFile = "/run/secrets/devbox-github-token";
                paseoPasswordFile = "/run/secrets/devbox-paseo-password";
                signingKeyFile = "/run/secrets/devbox-signing-key";
                tailnetHostname = "devbox.example.ts.net";
                hostAddress = "192.168.100.26";
                localAddress = "192.168.100.27";
              };
              # Overrides gitIdentity, to prove the override reaches the
              # container and does not leak into the other instance.
              workbox = {
                githubTokenFile = "/run/secrets/workbox-github-token";
                paseoPasswordFile = "/run/secrets/workbox-paseo-password";
                signingKeyFile = "/run/secrets/workbox-signing-key";
                tailnetHostname = "workbox.example.ts.net";
                hostAddress = "192.168.100.28";
                localAddress = "192.168.100.29";
                gitIdentity = {
                  name = "Other Person";
                  email = "other@example.com";
                };
              };
              # No signing key. Exists only to pin the other branch of the
              # signing gate: getting that branch wrong produces a container
              # whose git refuses to commit at all, which is worse than one
              # that simply does not sign.
              nokey = {
                githubTokenFile = "/run/secrets/nokey-github-token";
                paseoPasswordFile = "/run/secrets/nokey-paseo-password";
                tailnetHostname = "nokey.example.ts.net";
                hostAddress = "192.168.100.30";
                localAddress = "192.168.100.31";
              };
            };
          };
        }
      ];
    }).config;

  container = name: host.containers.${name};
  gitSettings = name: (container name).config.home-manager.users.agent.programs.git.settings;
  gitUser = name: (gitSettings name).user;
  signsCommits =
    name:
    let
      settings = gitSettings name;
    in
    (settings.user.signingkey or null) == "/run/secrets/signing-key"
    && (settings.gpg.format or null) == "ssh"
    && (settings.commit.gpgSign or false) == true
    && (container name).bindMounts ? "/run/secrets/signing-key";

  homeFiles = name: (container name).config.home-manager.users.agent.home.file;
  homeActivation = name: (container name).config.home-manager.users.agent.home.activation;

  # Pure data imported directly: the pi plugin and tier config is what keeps
  # a model or plugin bump honest, and every property below is visible at
  # eval time.
  piData = import ../modules/pi-coding-agent/settings.nix;
  # Plugin membership is the whole declarative surface for plugins now -
  # a pure data file with no versions, so it imports directly and asserts
  # against it without building anything.
  pluginMembership = import ../modules/devbox/plugins.nix;
  llmCatalog = import ../modules/local-llm/models.nix;
  servedIds = map (id: "${llmCatalog.provider}/${id}") (
    builtins.concatMap (
      name: [ name ] ++ builtins.attrNames (llmCatalog.models.${name}.aliases or { })
    ) llmCatalog.enabled
  );
  roles = piData.settings.subagents.agentOverrides;
  budgetAliases = builtins.attrNames (llmCatalog.models.${llmCatalog.default}.aliases or { });
  # The one custom agent. Asserted as text because what matters about it is
  # mostly what it does *not* say - see the frontmatter check below.
  wpAgent = builtins.readFile ../modules/pi-coding-agent/agents/wp.md;
  wpFrontmatter = builtins.head (builtins.match "---\n(.*)\n---\n.*" wpAgent);
  # writeShellScriptBin names its derivation after the binary, so the package
  # name is the command an agent session actually types.
  pkgNamed =
    name: pkgName:
    lib.findFirst (p: (p.name or "") == pkgName) null
      (container name).config.environment.systemPackages;

  checks = [
    {
      name = "every instance is defined";
      ok =
        lib.attrNames host.containers == [
          "devbox"
          "nokey"
          "workbox"
        ];
    }
    {
      name = "each container keeps its own veth addresses";
      ok =
        (container "devbox").hostAddress == "192.168.100.26"
        && (container "devbox").localAddress == "192.168.100.27"
        && (container "workbox").hostAddress == "192.168.100.28"
        && (container "workbox").localAddress == "192.168.100.29";
    }
    {
      name = "NAT lists every instance's veth";
      ok =
        lib.sort lib.lessThan host.networking.nat.internalInterfaces == [
          "ve-devbox"
          "ve-nokey"
          "ve-workbox"
        ];
    }
    {
      name = "each instance gets its own tailscale state directory";
      ok =
        lib.elem "d /var/lib/tailscale-devbox 0700 root root -" host.systemd.tmpfiles.rules
        && lib.elem "d /var/lib/tailscale-workbox 0700 root root -" host.systemd.tmpfiles.rules
        && lib.elem "d /var/lib/tailscale-nokey 0700 root root -" host.systemd.tmpfiles.rules;
    }
    {
      name = "secrets bind-mount per-instance host paths onto shared container paths";
      ok =
        (container "devbox").bindMounts."/run/secrets/github-token".hostPath
        == "/run/secrets/devbox-github-token"
        &&
          (container "devbox").bindMounts."/run/secrets/paseo-password".hostPath
          == "/run/secrets/devbox-paseo-password"
        &&
          (container "workbox").bindMounts."/run/secrets/github-token".hostPath
          == "/run/secrets/workbox-github-token"
        &&
          (container "workbox").bindMounts."/run/secrets/paseo-password".hostPath
          == "/run/secrets/workbox-paseo-password";
    }
    {
      name = "gitIdentity defaults, and an override applies to one instance only";
      ok =
        (gitUser "devbox").name == "BJSummerfield"
        && (gitUser "devbox").email == "brianjsummerfield@gmail.com"
        && (gitUser "workbox").name == "Other Person"
        && (gitUser "workbox").email == "other@example.com";
    }
    {
      name = "a keyed instance mounts its own key and signs with it";
      ok =
        signsCommits "devbox"
        && signsCommits "workbox"
        &&
          (container "devbox").bindMounts."/run/secrets/signing-key".hostPath
          == "/run/secrets/devbox-signing-key"
        &&
          (container "workbox").bindMounts."/run/secrets/signing-key".hostPath
          == "/run/secrets/workbox-signing-key";
    }
    {
      # gpgSign left on without a key makes git refuse to commit outright,
      # so all three settings have to disappear together with the mount.
      name = "an unkeyed instance mounts no key and leaves signing off";
      ok =
        !((container "nokey").bindMounts ? "/run/secrets/signing-key")
        && !((gitUser "nokey") ? signingkey)
        && !((gitSettings "nokey").gpg or { } ? format)
        && !((gitSettings "nokey").commit or { } ? gpgSign);
    }
    {
      name = "each container is served on its own tailnet hostname";
      ok =
        (container "devbox").config.services.paseo.hostnames == [ "devbox.example.ts.net" ]
        && (container "workbox").config.services.paseo.hostnames == [ "workbox.example.ts.net" ];
    }
    # The six below take no per-instance argument - every container gets
    # them from the same container.nix - so one instance pins them rather
    # than repeating each assertion three times.
    {
      # Nix declares plugin membership only - which plugins, no versions,
      # no refs, no hashes - so nothing version-shaped can go stale
      # between rebuilds. What this check can see at eval time: pi's
      # specs are single-sourced from the one membership file, and
      # neither agent may also get a standalone skills link, which would
      # list every skill twice. (The claude side - the version-less
      # enabledPlugins entry in its settings seed - is a build-time fact
      # the container image build exercises, not eval-assertable.) A
      # temporary version pin against a bad release belongs in the
      # membership file itself - see its header - so this test asserts
      # single-sourcing, not pin-freeness.
      name = "plugins are declared as versionless membership, not double-seeded";
      ok =
        let
          files = homeFiles "devbox";
          membership = pluginMembership;
        in
        piData.settings.packages == membership.piPackages
        && !(files ? ".claude-state/skills")
        && !(files ? ".pi/agent/skills");
    }
    {
      # pi's settings.json must be a seeded writable copy - the home-
      # manager module's store-symlink write skipped via settings = {},
      # and the activation an install (0644), not a link - or pi's own
      # `pi install` / `pi remove` / `pi update` commands fail silently
      # against it and live updates stop working.
      name = "pi settings.json is seeded as a writable copy, not a store link";
      ok =
        let
          files = homeFiles "devbox";
          activations = homeActivation "devbox";
        in
        !(files ? ".pi/agent/settings.json")
        && (container "devbox").config.home-manager.users.agent.programs."pi-coding-agent".settings == { }
        && (lib.hasInfix ".pi/agent/settings.json" activations.piSettings.data)
        && (lib.hasInfix "-m 0644" activations.piSettings.data);
    }
    {
      # Claude has no APPEND_SYSTEM.md equivalent and its
      # appendSystemPromptFile settings key is inert on 2.1.234, so losing
      # this flag means the environment contract silently never reaches it.
      name = "the claude launcher injects the environment contract";
      ok =
        let
          claude = pkgNamed "devbox" "claude";
        in
        claude != null && lib.hasInfix "--append-system-prompt" claude.text;
    }
    {
      # llama-swap serves one model at a time; a role resolving to anything
      # but the served instance would evict the parent's loaded model
      # mid-session.
      name = "every subagent role maps to a served model or alias";
      ok = lib.all (r: lib.elem r.model servedIds) (lib.attrValues roles);
    }
    {
      # Fan-out children must take the smaller declared window so a
      # parallel wave compacts before it thrashes the KV pool; the two
      # judgement roles keep the full one.
      name = "fan-out roles take the budget alias, judgement roles the full window";
      ok =
        budgetAliases == [ ]
        ||
          lib.all (n: roles.${n}.model == "${llmCatalog.provider}/${builtins.head budgetAliases}") [
            "worker"
            "researcher"
            "scout"
          ]
          && lib.all (n: roles.${n}.model == "${llmCatalog.provider}/${llmCatalog.default}") [
            "wp"
            "reviewer"
          ];
    }
    {
      # Low effort on the NVFP4 build trades per-turn speed for retries, so
      # medium is the floor - for the role overrides, for the default every
      # unlisted agent inherits, and for the chat-template map every pi
      # request goes through. maxThinking is the other half: it is what
      # stops an agent nobody listed here inheriting the session's `high`,
      # which the map escalates to xhigh.
      name = "nothing requests low thinking";
      ok =
        let
          allowed = [
            "medium"
            "high"
            "xhigh"
          ];
          subagents = piData.settings.subagents;
        in
        lib.all (r: lib.elem (r.thinking or "medium") allowed) (lib.attrValues roles)
        && lib.elem subagents.defaultThinking allowed
        && lib.elem subagents.maxThinking allowed
        && lib.all (
          name:
          lib.all (
            v:
            lib.elem v [
              "medium"
              "xhigh"
            ]
          ) (lib.attrValues (llmCatalog.models.${name}.thinkingLevels or { }))
        ) llmCatalog.enabled;
    }
    {
      # The custom agent dir is a plain store link (pi only reads agent
      # files), unlike settings.json and the extension config.
      name = "the wp sub-orchestrator is seeded as a user agent";
      ok = (homeFiles "devbox") ? ".pi/agent/agents";
    }
    {
      # Three fields whose *presence* would break the design, each in a way
      # that looks like a reasonable edit:
      #   maxSubagentDepth - is a ceiling on the agent itself, so 1 on a
      #     depth-1 sub-orchestrator blocks every dispatch it makes;
      #   extensions - is a path allowlist whose presence disables every
      #     other extension, so it would remove wp's web access;
      #   model / thinking - an agentOverrides entry only fills fields a
      #     *custom* agent leaves unset, so declaring them here takes wp's
      #     tier out of settings.nix and silently ignores the override.
      name = "wp declares nesting and nothing that would disable it";
      ok =
        lib.hasInfix "allowNestedSubagents: true" wpFrontmatter
        && lib.hasInfix "defaultContext: fresh" wpFrontmatter
        && !(lib.hasInfix "maxSubagentDepth" wpFrontmatter)
        && !(lib.hasInfix "extensions" wpFrontmatter)
        && !(lib.hasInfix "model:" wpFrontmatter)
        && !(lib.hasInfix "thinking:" wpFrontmatter)
        && roles ? wp;
    }
    {
      # depth 0 root -> depth 1 wp -> depth 2 worker/reviewer/researcher,
      # and a depth-2 child cannot spawn. Stated rather than inherited so
      # the shape does not ride on an upstream default.
      name = "the delegation tree is capped at depth 2";
      ok = piData.subagentsConfig.maxSubagentDepth == 2;
    }
    {
      # A list, not "auto" or "all": both of those resolve to exa alone
      # while no API key is set, which is the throttling being escaped.
      # More than one provider is the property that matters - failures are
      # per-provider, so a second entry is what turns a throttled exa into
      # a thinner result set rather than a failed search.
      name = "web search fans out across more than one keyless provider";
      ok =
        let
          w = piData.webSearch;
        in
        builtins.isList w.provider
        && lib.length w.provider >= 2
        && lib.elem "exa" w.provider
        && lib.elem "duckduckgo" w.provider;
    }
    {
      # The bundled researcher gets its web tools from its own frontmatter
      # (web_search, fetch_content, get_search_content) and keeps ambient
      # extensions because it declares no `extensions` field. There are
      # exactly two ways to take that away from here: a defaultExtensions
      # allowlist, or an override that narrows a role's tools or
      # extensions. Neither belongs in this config.
      name = "nothing here takes web access away from subagents";
      ok =
        let
          s = piData.settings.subagents;
        in
        !(s ? defaultExtensions)
        && s.agentOverrides ? researcher
        && lib.all (r: !(r ? tools) && !(r ? extensions)) (lib.attrValues s.agentOverrides);
    }
  ];

  failures = builtins.filter (c: !c.ok) checks;
in
pkgs.runCommand "devboxes-eval-tests" { } (
  if failures == [ ] then
    "touch $out"
  else
    ''
      ${lib.concatMapStringsSep "\n" (f: "echo ${lib.escapeShellArg "FAIL: ${f.name}"} >&2") failures}
      exit 1
    ''
)
