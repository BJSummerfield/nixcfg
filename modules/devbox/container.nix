{
  inputs,
  tailnetHostname,
  gitIdentity,
  signCommits,
}:
{
  config,
  pkgs,
  lib,
  ...
}:
let
  inherit (import ./agents.nix { inherit pkgs lib; }) mkAgent;

  envContract = ./ENVIRONMENT.md;

  piWrapped = pkgs.symlinkJoin {
    name = "pi-wrapped";
    paths = [ pkgs.pi-coding-agent ];
    nativeBuildInputs = [ pkgs.makeWrapper ];
    postBuild = ''
      wrapProgram $out/bin/pi --suffix PATH : ${lib.makeBinPath (import ../pi-coding-agent/extra-packages.nix pkgs)}
    '';
  };

  agentPkgs = [
    (mkAgent {
      name = "claude";
      real = lib.getExe pkgs.claude-code;
      args = ''--append-system-prompt "$(cat ${envContract})"'';
    })
    (mkAgent {
      name = "pi";
      real = "${piWrapped}/bin/pi";
    })
  ];

  ghWrapped = pkgs.writeShellScriptBin "gh" ''
    export GH_TOKEN=$(cat /run/secrets/github-token)
    exec ${lib.getExe pkgs.gh} "$@"
  '';

  # To manually remove stale plugin state after removing an enabledPlugins entry:
  #   claude plugin uninstall superpowers@claude-plugins-official
  #   claude plugin marketplace remove claude-plugins-official
  #   claude plugin list
  claudeSettings = pkgs.writeText "claude-settings.json" (
    builtins.toJSON {
      theme = "dark";
      inputNeededNotifEnabled = true;
      agentPushNotifEnabled = true;
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
  nix.nixPath = [ "nixpkgs=flake:nixpkgs" ];

  mine.allowedUnfree = [ "claude-code" ];

  environment.systemPackages =
    agentPkgs
    ++ [ ghWrapped ]
    ++ (with pkgs; [
      curl
      fd
      jq
      ripgrep
      git
      direnv
    ]);

  environment.sessionVariables = {
    CLAUDE_CONFIG_DIR = "/home/agent/.claude-state";
    DISABLE_AUTOUPDATER = "1";
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
        home.file.".pi/agent/APPEND_SYSTEM.md".source = envContract;

        programs.git = {
          enable = true;
          settings = {
            user = {
              inherit (gitIdentity) name email;
            }
            // lib.optionalAttrs signCommits {
              signingkey = "/run/secrets/signing-key";
            };
            credential."https://github.com".helper =
              "!f() { echo username=x-access-token; echo password=$(cat /run/secrets/github-token); }; f";
          }
          // lib.optionalAttrs signCommits {
            gpg.format = "ssh";
            commit.gpgSign = true;
          };
        };

        home.activation.claudeSettings = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
          run mkdir -p $VERBOSE_ARG "$HOME/.claude-state"
          run rm -f $VERBOSE_ARG "$HOME/.claude-state/settings.json"
          run install $VERBOSE_ARG -m 0644 ${claudeSettings} \
            "$HOME/.claude-state/settings.json"
        '';
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
      CLAUDE_CONFIG_DIR = "/home/agent/.claude-state";
      DISABLE_AUTOUPDATER = "1";
      PASEO_WEB_UI_ENABLED = "true";
    };
  };

  systemd.services.paseo.serviceConfig.EnvironmentFile = "/run/secrets/paseo-password";

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
  ];

  system.stateVersion = "26.05";
}
