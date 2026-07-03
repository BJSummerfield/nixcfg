# Once the container is running log into it with
# sudo nixos-container root-login local-llm
# tailscale up --hostname=llm --advertise-tags=tag:solo-node
# tailscale serve --bg --https=443 8080      # Open WebUI
# tailscale serve --bg --https=8443 8081     # llama.cpp endpoint for OpenCode
{ lib, config, pkgs, ... }:
let
  cfg = config.mine.system.local-llm;

  qwenName = "Qwen3.6-35B-A3B-GGUF";
  qwenFile = "Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf";
  qwenModel = pkgs.fetchurl {
    url = "https://huggingface.co/unsloth/${qwenName}/resolve/main/${qwenFile}";
    hash = "sha256-cHpVqKQ5fs3kTeDEmdPmjBrR0kDR2mWCa0lJ0QQ/RFA=";
  };
in
{
  options.mine.system.local-llm = {
    enable = lib.mkEnableOption "Enable Local LLM container";
  };
  config = lib.mkIf cfg.enable {
    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-local-llm" ];
      externalInterface = config.mine.system.externalInterface;
    };
    system.activationScripts.local-llm-dirs = ''
      mkdir -p /var/lib/local-llm
      chmod 755 /var/lib/local-llm
    '';
    containers.local-llm = {
      autoStart = false;
      privateNetwork = true;
      hostAddress = "192.168.100.24";
      localAddress = "192.168.100.25";
      bindMounts = {
        "/var/lib" = {
          hostPath = "/var/lib/local-llm";
          isReadOnly = false;
        };
        "/var/lib/models/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf" = {
          hostPath = "${qwenModel}";
          isReadOnly = true;
        };
      };
      config = {
        networking = {
          nameservers = [ "9.9.9.9" "1.1.1.1" ];
          firewall.enable = true;
        };
        system.stateVersion = "24.11";
      };
    };
  };
}
