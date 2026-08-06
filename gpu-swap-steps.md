# 5090 local-llm steps (OCI vLLM)

## Now: roll out the podman-based vLLM

1. On redtruck, pull the branch, then rebuild (the only CUDA compile left is
   llama.cpp — far smaller than the old vllm/torch stack):
   ```bash
   tmux new -s build
   sudo nixos-rebuild switch --flake .#redtruck --max-jobs 1 --cores 8
   ```
   This also activates zram + the 1-job default for future builds.
2. The `vllm-image-pull` service pulls the pinned image (~10+ GB) on switch;
   watch/verify with:
   ```bash
   systemctl status vllm-image-pull
   sudo podman images
   ```
   If the pull 404s, check the latest tag with
   `podman search --list-tags docker.io/vllm/vllm-openai`, fix `vllmImage`
   in `modules/local-llm/nixos.nix`, and re-switch.
3. Restart the container and confirm all four models are listed:
   ```bash
   sudo systemctl restart container@local-llm
   curl http://localhost:8081/v1/models
   ```
4. Load an NVFP4 model (first request podman-runs its container; expect a
   slow first health-check while weights load):
   ```bash
   curl http://localhost:8081/v1/chat/completions \
     -H 'Content-Type: application/json' \
     -d '{"model":"Qwen3.6-27B-NVFP4","messages":[{"role":"user","content":"hi"}]}'
   ```
5. Watch it work: `sudo podman ps` and `nvtop` on the host. Ask for a
   different model and llama-swap stops one container and starts the other.
   Idle models stop themselves after 1h (ttl).
6. Check the quant backend vLLM picked (marlin expected for non-Fast NVFP4):
   ```bash
   sudo podman logs vllm-qwen27b-nvfp4 2>&1 | grep -i -E 'marlin|cutlass|cute'
   ```
7. Merge `add-nvidia-support` to main and push.

## Later: update vLLM

1. Edit the `vllmImage` tag in `modules/local-llm/nixos.nix`.
2. Rebuild and restart (the switch re-runs `vllm-image-pull` automatically):
   ```bash
   sudo nixos-rebuild switch --flake .#redtruck
   sudo systemctl restart container@local-llm
   ```
3. Once the new version works, delete the superseded tag explicitly —
   versioned tags never go dangling, so `image prune` won't catch them:
   ```bash
   sudo podman rmi docker.io/vllm/vllm-openai:vOLD
   ```
