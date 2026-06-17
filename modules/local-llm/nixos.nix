# Once the container is running log into it with
# sudo nixos-container root-login local-llm
# tailscale up --hostname=llm --advertise-tags=tag:solo-node
# tailscale serve --bg 8080

{ lib, config, pkgs, ... }:
let
  cfg = config.mine.system.local-llm;
in
{
  options.mine.system.local-llm = {
    enable = lib.mkEnableOption "Enable Local LLM container";
  };

  config = lib.mkIf cfg.enable {
    # AMD GPU drivers on the host
    hardware.graphics = {
      enable = true;
      extraPackages = [
        pkgs.rocmPackages.clr.icd
      ];
    };

    # Expose web UI to lan - not needed if only being accessed through tailnet
    networking.firewall.allowedTCPPorts = [ 8080 ];
    networking.nat.forwardPorts = [
      {
        sourcePort = 8080;
        destination = "192.168.100.25:8080";
        proto = "tcp";
      }
    ];

    # Allow traffic to enter the container
    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-local-llm" ];
      externalInterface = config.mine.system.externalInterface;
    };

    # Make needed directories - just the parent; systemd creates the
    # service state dirs inside it with correct (DynamicUser) ownership.
    system.activationScripts.local-llm-dirs = ''
      mkdir -p /var/lib/local-llm
      chmod 755 /var/lib/local-llm
    '';

    containers.local-llm = {
      autoStart = false;
      privateNetwork = true;
      hostAddress = "192.168.100.24";
      localAddress = "192.168.100.25";

      # tun is needed for tailscale network
      # AMD GPU devices for ROCm acceleration
      allowedDevices = [
        { modifier = "rwm"; node = "/dev/net/tun"; }
        { modifier = "rwm"; node = "/dev/dri/renderD128"; }
        { modifier = "rwm"; node = "/dev/kfd"; }
      ];

      bindMounts = {
        # needed for tailscale network
        "/dev/net/tun" = {
          hostPath = "/dev/net/tun";
          isReadOnly = false;
        };
        # GPU passthrough - render node + AMD kernel fusion driver
        "/dev/dri" = {
          hostPath = "/dev/dri";
          isReadOnly = false;
        };
        "/dev/kfd" = {
          hostPath = "/dev/kfd";
          isReadOnly = false;
        };
        # GPU drivers from host - avoids duplicating hardware.graphics in container
        "/run/opengl-driver" = {
          hostPath = "/run/opengl-driver";
          isReadOnly = true;
        };
        # Single persistence mount. systemd creates + owns the tailscale,
        # ollama, and open-webui state dirs inside with correct ownership
        # (incl. DynamicUser), and they land on the host automatically.
        # Persists: tailscale node identity, pulled models, webui accounts/history.
        "/var/lib" = {
          hostPath = "/var/lib/local-llm";
          isReadOnly = false;
        };
      };

      config = { config, pkgs, lib, ... }: {
        services.tailscale.enable = true;

        services.ollama = {
          enable = true;
          package = pkgs.ollama-rocm;
          environmentVariables = {
            HCC_AMDGPU_TARGET = "gfx1100";
            OLLAMA_KEEP_ALIVE = "5m";
          };
          rocmOverrideGfx = "11.0.0";
          loadModels = [
            "qwen3.6:27b"
          ];
        };

        services.open-webui = {
          enable = true;
          host = "0.0.0.0";
          port = 8080;
          environment = {
            OLLAMA_API_BASE_URL = "http://127.0.0.1:11434";
            # Auth ON - each person gets their own account + chat history
            WEBUI_AUTH = "True";
            # First account created becomes admin. Flip to "False" and
            # rebuild once your users are registered to lock signups.
            ENABLE_SIGNUP = "True";
          };
        };

        networking = {
          # needed to get the dns for https nameserver
          nameservers = [ "9.9.9.9" "1.1.1.1" ];
          firewall = {
            enable = true;
            # Lan access
            allowedTCPPorts = [ 8080 ];
            # allows connection from other tailscale devices
            trustedInterfaces = [ "tailscale0" ];
            allowedUDPPorts = [ config.services.tailscale.port ];
          };
        };

        nixpkgs.config.allowUnfreePredicate = pkg:
          builtins.elem (lib.getName pkg) [ "open-webui" ];

        environment.systemPackages = with pkgs; [
          amdgpu_top
        ];

        system.stateVersion = "24.11";
      };
    };
  };
}
