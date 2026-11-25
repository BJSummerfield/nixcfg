{
  inputs,
  tailnetHostname,
  signCommits,
  hasEnvironmentFile,
  hasClaudeToken,
  hasGithubToken,
  withClaude,
}:
{
  config,
  pkgs,
  lib,
  ...
}:
let
  inherit (import ./agents.nix { inherit pkgs lib; }) mkAgent;

  instructions = import ./instructions.nix;

  envContract = pkgs.writeText "ENVIRONMENT.md" instructions.environment;

  piWrapped = pkgs.symlinkJoin {
    name = "pi-wrapped";
    paths = [ (pkgs.callPackage ../pi-coding-agent/package.nix { }) ];
    nativeBuildInputs = [ pkgs.makeWrapper ];
    postBuild = ''
      wrapProgram $out/bin/pi --suffix PATH : ${
        lib.makeBinPath [
          pkgs.nodejs
          pkgs.bun
        ]
      }
    '';
  };

  agentPkgs =
    lib.optional withClaude (mkAgent {
      name = "claude";
      real =
        if hasClaudeToken then
          pkgs.writeShellScript "claude" ''
            export CLAUDE_CODE_OAUTH_TOKEN="$(cat /run/secrets/claude-token)"
            exec ${lib.getExe pkgs.claude-code} "$@"
          ''
        else
          lib.getExe pkgs.claude-code;
      args = ''--append-system-prompt "$(cat ${envContract})"'';
    })
    ++ [
      (mkAgent {
        name = "pi";
        real = "${piWrapped}/bin/pi";
      })
    ];

  ghWrapped = pkgs.writeShellScriptBin "gh" ''
    export GH_TOKEN=$(cat /run/secrets/github-token)
    exec ${lib.getExe pkgs.gh} "$@"
  '';

  claudeSettings = pkgs.writeText "claude-settings.json" (
    builtins.toJSON {
      theme = "dark";
      inputNeededNotifEnabled = true;
      agentPushNotifEnabled = true;
      attribution = {
        commit = "";
        pr = "";
      };
    }
  );
in
{
  imports = [
    inputs.home-manager.nixosModules.home-manager
    inputs.paseo.nixosModules.paseo
    ../unfree/nixos.nix
  ];

  users.users.agent = {
    isNormalUser = true;
    uid = 1500;
    home = "/home/agent";
    description = "coding agent";
  };

  nix.settings.experimental-features = [
    "nix-command"
    "flakes"
  ];
  nix.registry.nixpkgs.flake = inputs.nixpkgs;
  nix.settings.nix-path = [ "nixpkgs=flake:nixpkgs" ];

  mine.allowedUnfree = lib.optional withClaude "claude-code";

  environment.systemPackages =
    agentPkgs
    ++ lib.optional hasGithubToken ghWrapped
    ++ (with pkgs; [
      curl
      fd
      jq
      ripgrep
      git
      direnv
    ]);

  # claudeTokenFile: run `claude setup-token` once, anywhere you can open a
  # browser, and store the token with sops in secrets/hosts/redtruck.yaml.
  # Instances without one log in once as agent, from the host:
  #   sudo nixos-container run devbox -- runuser -u agent -- \
  #     env CLAUDE_CONFIG_DIR=/home/agent/.claude-state claude auth login
  environment.sessionVariables = {
    DISABLE_AUTOUPDATER = "1";
    TMPDIR = "/var/tmp";
  }
  // lib.optionalAttrs withClaude {
    CLAUDE_CONFIG_DIR = "/home/agent/.claude-state";
  };

  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    users.agent =
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

        programs.pi-coding-agent.package = null;

        programs.direnv.config.whitelist.prefix = [
          "/home/agent/projects"
          "/var/lib/paseo/worktrees"
        ];

        home.packages = agentPkgs;

        programs.git = {
          enable = true;
          settings = {
            user = {
              name = "BJSummerfield";
              email = "brianjsummerfield@gmail.com";
            }
            // lib.optionalAttrs signCommits {
              signingkey = "/run/secrets/signing-key";
            };
          }
          // lib.optionalAttrs hasGithubToken {
            credential."https://github.com".helper =
              "!f() { echo username=x-access-token; echo password=$(cat /run/secrets/github-token); }; f";
          }
          // lib.optionalAttrs signCommits {
            gpg.format = "ssh";
            commit.gpgSign = true;
          };
        };

        home.file.".claude-state/CLAUDE.md" = lib.mkIf withClaude {
          text = builtins.readFile ./writing.md + "\n" + instructions.delegation;
        };

        home.activation.claudeSettings = lib.mkIf withClaude (
          lib.hm.dag.entryAfter [ "linkGeneration" ] ''
            run mkdir -p $VERBOSE_ARG "$HOME/.claude-state"
            run rm -f $VERBOSE_ARG "$HOME/.claude-state/settings.json"
            run install $VERBOSE_ARG -m 0644 ${claudeSettings} \
              "$HOME/.claude-state/settings.json"
          ''
        );
      };
  };

  services.paseo = {
    enable = true;
    user = "agent";
    group = "users";
    port = 6767;
    listenAddress = "127.0.0.1";
    openFirewall = false;
    relay.enable = false;
    hostnames = [ tailnetHostname ];
    dataDir = "/var/lib/paseo";
    environment = {
      DISABLE_AUTOUPDATER = "1";
      PASEO_WEB_UI_ENABLED = "true";
      TMPDIR = "/var/tmp";
    }
    // lib.optionalAttrs withClaude {
      CLAUDE_CONFIG_DIR = "/home/agent/.claude-state";
    };
  };

  systemd.services.paseo.serviceConfig.EnvironmentFile = [
    "/run/secrets/paseo-password"
  ]
  ++ lib.optional hasEnvironmentFile "/run/secrets/environment";

  systemd.services.paseo.serviceConfig.OOMPolicy = "continue";

  systemd.services.paseo.serviceConfig.ExecStartPre = [
    (
      "+"
      + toString (
        pkgs.writeShellScript "paseo-password-check" ''
          if ! ${lib.getExe pkgs.gnugrep} -Eq '^PASEO_PASSWORD=.+' /run/secrets/paseo-password; then
            echo "paseo-password: no non-empty PASEO_PASSWORD=<value> line found - refusing to start paseo unauthenticated (value withheld)" >&2
            exit 1
          fi
        ''
      )
    )
  ];

  services.tailscale.enable = true;

  networking = {
    nameservers = [
      "9.9.9.9"
      "1.1.1.1"
    ];
    firewall = {
      enable = true;
      trustedInterfaces = [ "tailscale0" ];
      allowedUDPPorts = [ config.services.tailscale.port ];
    };
  };

  systemd.tmpfiles.rules = [
    "d /home/agent/projects 0755 agent users -"
    "d /var/lib/paseo/worktrees 0755 agent users -"
    "d /var/tmp/pi-plans 0755 agent users 20d"
    "d /var/tmp/pi-plans/locks 0755 agent users -"
    "x /var/tmp/pi-plans/locks"
  ]
  ++ lib.optional withClaude "d /var/tmp/claude-1500 0755 agent users 20d";

  system.stateVersion = "26.05";
}
