# 5090 swap + vLLM steps

## Now: build for boot

1. Push the branch (from the machine with the rebased branch):
   ```bash
   git push --force-with-lease origin add-nvidia-support
   ```
2. On redtruck, in the repo:
   ```bash
   git fetch origin
   git checkout add-nvidia-support
   git pull --ff-only origin add-nvidia-support
   ```
3. Build without activating (AMD card still installed — don't `switch`):
   ```bash
   sudo nixos-rebuild boot --flake .#redtruck
   ```
4. Shut down and swap the card (direct 16-pin PSU cable, no daisy-chain):
   ```bash
   sudo poweroff
   ```
5. Boot, then verify:
   ```bash
   nvidia-smi
   lsmod | grep nvidia
   nvtop
   ```
   Rollback if broken: pick the previous generation in the boot menu.
6. Merge `add-nvidia-support` to main and push.

## Later: enable the CUDA/vLLM stack

1. In `hosts/redtruck/default.nix` add:
   ```nix
   local-llm.cuda.enable = true;
   ```
2. Rebuild (multi-hour source build, bounded so it won't OOM):
   ```bash
   sudo nixos-rebuild switch --flake .#redtruck
   ```
3. Restart container and check models:
   ```bash
   sudo systemctl restart container@local-llm
   curl http://localhost:8081/v1/models
   ```

## Later: update vLLM (when 0.25 lands)

1. Check master's version:
   ```bash
   nix eval --raw github:nixos/nixpkgs/master#vllm.version
   ```
2. If ≥ 0.25, bump only the vllm input:
   ```bash
   nix flake update nixpkgs-vllm
   ```
3. Commit the lock change on its own, then rebuild + restart:
   ```bash
   sudo nixos-rebuild switch --flake .#redtruck
   sudo systemctl restart container@local-llm
   ```
4. Check the chosen backend (marlin expected for the non-Fast quants):
   ```bash
   sudo nixos-container root-login local-llm
   journalctl -u llama-swap | grep -i -E "marlin|cutlass|cute"
   ```
5. Cleanup once nixos-unstable itself ships ≥ 0.25: `nix flake update nixpkgs`,
   drop the `nixpkgs-vllm` input from `flake.nix`, revert `cudaPkgs` to
   `import pkgs.path`.
