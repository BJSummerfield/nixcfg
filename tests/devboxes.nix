# Pure-eval checks for the multi-instance devbox module: every instance's
# values derive from its attribute name and are visible at eval time, so no
# VM is needed. Tailnet join and `tailscale serve` stay manual — the module
# keeps them out of Nix.
{
  nixpkgs,
  inputs,
  system,
}:
let
  inherit (nixpkgs) lib;
  pkgs = nixpkgs.legacyPackages.${system};

  # Just the modules under test plus the minimum NixOS needs to evaluate; the
  # full set (modules/nixos.nix) would be slow and couple to untested modules.
  host =
    (lib.nixosSystem {
      specialArgs = { inherit inputs; };
      modules = [
        # sops-nix must be present: modules/system/nixos.nix sets
        # sops.age.sshKeyPaths, so its option tree has to evaluate.
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
              # Overrides gitIdentity, to prove the override applies without
              # leaking into the other instance.
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
              # No signing key: pins the no-key branch of the signing gate —
              # a mistake there makes git refuse to commit at all, worse
              # than not signing.
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

  # Pure data imported directly: the pi settings and tier config is what
  # keeps a model or plugin bump honest, and every property is visible at
  # eval time.
  piData = import ../modules/pi-coding-agent/settings.nix;
  # Plugin membership is the whole declarative surface — a pure data file
  # with no versions, importable without building anything.
  pluginMembership = import ../modules/devbox/plugins.nix;
  llmCatalog = import ../modules/local-llm/models.nix;
  servedIds = map (id: "${llmCatalog.provider}/${id}") (
    builtins.concatMap (
      name: [ name ] ++ builtins.attrNames (llmCatalog.models.${name}.aliases or { })
    ) llmCatalog.enabled
  );
  tiers = piData.superagents.superagents.modelTiers;
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
    # The six below take no per-instance argument — every container gets them
    # from the same container.nix — so one instance pins them instead of
    # repeating each assertion three times.
    {
      # Nix declares membership only — no versions — so nothing version-
      # shaped can go stale; this check sees pi single-sourced from the
      # membership file and no standalone skills link (which would list every
      # skill twice). A temporary pin belongs in the membership file — see
      # its header — so this asserts single-sourcing, not pin-freeness.
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
      # pi's settings.json must be a seeded writable copy, not a store link —
      # or pi's own `pi install` / `pi remove` / `pi update` fail silently
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
      # Claude has no APPEND_SYSTEM.md equivalent and its appendSystemPromptFile
      # key is inert on 2.1.234, so losing this flag silently drops the
      # environment contract.
      name = "the claude launcher injects the environment contract";
      ok =
        let
          claude = pkgNamed "devbox" "claude";
        in
        claude != null && lib.hasInfix "--append-system-prompt" claude.text;
    }
    {
      # llama-swap serves one model at a time; a tier resolving elsewhere
      # would evict the parent's loaded model mid-session.
      name = "every superagents tier maps to a served model or alias";
      ok = lib.all (t: lib.elem t.model servedIds) (lib.attrValues tiers);
    }
    {
      # Fan-out children must take the smaller declared window so a parallel
      # wave compacts before it thrashes the KV pool.
      name = "the cheap tier uses the default model's budget alias";
      ok =
        let
          aliases = builtins.attrNames (llmCatalog.models.${llmCatalog.default}.aliases or { });
        in
        aliases == [ ] || tiers.cheap.model == "${llmCatalog.provider}/${builtins.head aliases}";
    }
    {
      # Low effort on the NVFP4 build trades per-turn speed for retries, so
      # medium is the floor — for both superagents tiers and the chat-template
      # map every pi request goes through.
      name = "nothing requests low thinking";
      ok =
        lib.all (
          t:
          lib.elem (t.thinking or "medium") [
            "medium"
            "high"
            "xhigh"
          ]
        ) (lib.attrValues tiers)
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
