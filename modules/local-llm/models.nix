# The one place a model is described. Pure data, no pkgs/config/arguments, so
# any module can import it - including hosts with no GPU.
#
# Consumed by:
#   local-llm/{weights,llama-swap}.nix  - what to fetch, how to serve it
#   pi-coding-agent/settings.nix        - provider list, default, subagent tiers
#   opencode/settings.nix               - provider entry, default
#
# Adding a model: write its attrset here, add the name to `enabled`, rebuild.
# Entries not in `enabled` are inert text - nothing is fetched or served.
# The generator emits --limit-mm-per-prompt, --enable-auto-tool-choice and an
# MTP --speculative-config unconditionally, so an entry must be an MTP-capable
# Qwen3.6-family VL model or llama-swap.nix needs a change too.
{
  provider = "redtruck";
  baseUrl = "https://llm.mist-gamma.ts.net:8443/v1";

  models = {
    "Qwen3.6-27B-NVFP4" = {
      displayName = "Qwen3.6 27B NVFP4 (redtruck)";
      repo = "unsloth/Qwen3.6-27B-NVFP4";
      files = {
        "added_tokens.json" = "sha256-5fm/tkTq0TvTbdbPxBVTqTt8JkwKLhrGfQM6qCUMhTg=";
        "chat_template.jinja" = "sha256-VdSTFDP+UCt5Qibuf00gamvdQ2rJ+A632Ou0xjn56gw=";
        "config.json" = "sha256-6rZIvJEuddrPMkRSYWHhOExsIk0iRI3B4j5oYqlfujw=";
        "configuration.json" = "sha256-LURk4urQa8m8cYx4EwmtHnut7WJtZujc3ItGm6GF+vA=";
        "generation_config.json" = "sha256-0Nv2cMajcoF7L/ktXUfjEw013pw6cWS6RV/XqIJVs2I=";
        "model-00001-of-00005.safetensors" = "sha256-dCUxG+GSaujbE0Schv96A+RGXMt8a1mUV7E5JgPESGc=";
        "model-00002-of-00005.safetensors" = "sha256-Fb/z0Knrro2HahehAmZrRkYBIKljmoQFhZXywuf/Q9A=";
        "model-00003-of-00005.safetensors" = "sha256-vuSQLzB+JW+nC+5kG6UxpSdCDHebIhSBNEhMcpXzSvw=";
        "model-00004-of-00005.safetensors" = "sha256-dM16p+tgoGTRA7deVyl5YPyQttsXUGYpcLj/k7KecoM=";
        "model-00005-of-00005.safetensors" = "sha256-sbNo/lPYpoygxoiRiV4EMIfe2krR1YgPzUjGnXgFjaE=";
        "model.safetensors.index.json" = "sha256-hrTN+o0fPRRemZ03xsCH7ChBbj9P2GKzS70nncJjXG8=";
        "preprocessor_config.json" = "sha256-uZGC4JRQ8mRTUCs8M5DM42sz3IxKHz7iGAd2LhaMdKs=";
        "processor_config.json" = "sha256-ziC+mi0omAc+h/99q8DX/UU/3iHpMJqjZIWombTCkQc=";
        "special_tokens_map.json" = "sha256-zly+c39KrMdpYYCqx0MJEQG1nk3FozjZ/IpvcWqlE/c=";
        "tokenizer.json" = "sha256-GmMpzuBz9EWB8ToRGpat3xKp2aZbKsb4H6RB7Btj9ck=";
        "tokenizer_config.json" = "sha256-v9Rr2krU/rJNwW/XoHgLz99qk+jruacSuWV93Eq6akY=";
        "video_preprocessor_config.json" = "sha256-WcXJ61IYLrFMBv+xDKnv/Smtzl8jipXeI8oUo429LLE=";
        "vocab.json" = "sha256-SrDVwJYpQFS2ZEShFqILr24pmY/B+uQQ/+S2+tvFa1w=";
      };

      reasoning = true;
      # measured pool: 195,750 tokens at gpu-memory-utilization 0.92, 149,796
      # at 0.94 (varies a few GiB with what the desktop is holding). If a
      # lean day shrinks the pool below this the server refuses to start -
      # step back to 114688 then.
      maxModelLen = 131072;
      # clients declare maxModelLen - headroom, so a long request is refused
      # up front instead of dying mid-generation
      headroom = 8192;
      maxTokens = 32768;
      sampling = { temperature = 0.6; top_p = 0.95; top_k = 20; min_p = 0.0; };

      # Seconds idle before llama-swap unloads, or null to stay resident. The
      # daily driver stays: a vLLM cold start is minutes, so an idle-unload
      # while you are out stalls the next remote query behind a full reload.
      # Free the card by hand instead:
      #   curl -X POST llama-swap:8081/api/models/unload
      ttl = null;

      vllm = {
        gpuMemoryUtilization = 0.94;
        # 3, so a parallel subagent wave gets real concurrency on the -32k
        # budget without outgrowing the KV pool
        maxNumSeqs = 3;
        maxNumBatchedTokens = 2048;
        kvCacheDtype = "fp8";
        # measured on this card: no-MTP with full cuda graphs ran 64 tok/s vs
        # 85-105 tok/s busy-window with MTP, dipping with draft acceptance on
        # hard content - net win, keep it
        speculativeTokens = 2;
        toolCallParser = "qwen3_xml";
        reasoningParser = "qwen3";
      };

      # Prefix caching stays OFF - there is deliberately no flag for it.
      # Forcing it on (mamba 'align' mode, which vLLM labels experimental)
      # preceded long sessions degrading into incoherent rewrite loops that
      # smeared variable names across drafts; corrupted resumed GDN state fits
      # the symptom. Cost: every turn re-prefills. If incoherence ever recurs
      # without it, the next suspect is fp8 kv above - switching to bf16 halves
      # the pool, so maxModelLen must drop to ~98304 with it.

      # Same running instance under a second name, so pi's subagent tiers can
      # declare a smaller window and compact early instead of outgrowing the
      # shared KV pool. Routing here never causes a model swap.
      aliases."Qwen3.6-27B-NVFP4-32k" = {
        displayName = "Qwen3.6 27B NVFP4 32k budget (redtruck)";
        contextWindow = 32768;
        maxTokens = 8192;
      };
    };

    # Catalog only - not in `enabled`, so nothing is fetched. Re-enable by
    # adding the name to the list below; if upstream has re-uploaded the repo
    # since, the hashes will need refreshing (the build fails loudly).
    "Qwen3.6-35B-A3B-NVFP4" = {
      displayName = "Qwen3.6 35B A3B NVFP4 (redtruck)";
      repo = "unsloth/Qwen3.6-35B-A3B-NVFP4";
      files = {
        "chat_template.jinja" = "sha256-6E8yoj/donaJ+GiqShpWIfQRM+UaSNfz78vqKDlXQlk=";
        "config.json" = "sha256-iCS/tunnFH4+EcEq0CNquzOF5QFV98vsdDnyWX22yx4=";
        "configuration.json" = "sha256-wbCdtBkRlRMkfpuLkSxLmJcQbJsgxsrafhB9mTxUNes=";
        "generation_config.json" = "sha256-0Nv2cMajcoF7L/ktXUfjEw013pw6cWS6RV/XqIJVs2I=";
        "model-00001-of-00006.safetensors" = "sha256-rm1t+KS6yFr3nGkStzYFMxB6jeifjrEGAIyHIgP0d7E=";
        "model-00002-of-00006.safetensors" = "sha256-BxqwqnuODs+AInxr5Rv622ZtKwVmCQqyYaQ5y9dly2M=";
        "model-00003-of-00006.safetensors" = "sha256-Zn76M4UBsIJCpJX4gUgAJwuWWQWvlzFJ1ZVaUjn3/P4=";
        "model-00004-of-00006.safetensors" = "sha256-bW/CuV3PJHQf9csITBuP7zpOc0THI7bnW0K8M9jmyqc=";
        "model-00005-of-00006.safetensors" = "sha256-Hk064nurGlcriLPKcossE2i8cTZMqeHFh2OlZGP4t2A=";
        "model-00006-of-00006.safetensors" = "sha256-NFgHS0by+SqGpvitE2hKZkqt99rsfjem8a2QIp1ZzPI=";
        "model.safetensors.index.json" = "sha256-dIUZE7xQhPLu0z1EISIKMmGLlGpMzGZZKbAgHO+zetk=";
        "preprocessor_config.json" = "sha256-JyJUUKycZSmHLuGST8sJYv9WNINPgXBA9EQRgRb05RY=";
        "processor_config.json" = "sha256-2J70nOnNN/v1EBWOE8HvBj2ShkEcHskEmTLb4EhxQ7E=";
        "tokenizer.json" = "sha256-GmMpzuBz9EWB8ToRGpat3xKp2aZbKsb4H6RB7Btj9ck=";
        "tokenizer_config.json" = "sha256-eS+j8MuIsRHlTvMTTIc1MQCMTfRx0QjaF5A0JuMIqns=";
        "video_preprocessor_config.json" = "sha256-d2ivJ8H6+pzJARwdwgBn4D+JFeA7Y1BFUOEdUGaYbRM=";
        "vocab.json" = "sha256-zpm0yymD0RiAbOCot3ejWwk+IAClA+veJYUyhMnfoAM=";
      };

      reasoning = true;
      maxModelLen = 32768;
      headroom = 4096;
      maxTokens = 8192;
      sampling = { temperature = 0.6; top_p = 0.95; top_k = 20; min_p = 0.0; };
      ttl = 3600;

      vllm = {
        gpuMemoryUtilization = 0.94;
        maxNumSeqs = 2;
        maxNumBatchedTokens = 2048;
        # fp8 kv cache preceded incoherent output on this MoE, so this runs
        # on vLLM's default kv cache dtype instead of an explicit one
        # (Unsloth: switch off fp8 if it shows instability)
        kvCacheDtype = "auto";
        speculativeTokens = 2;
        toolCallParser = "qwen3_xml";
        reasoningParser = "qwen3";
      };
    };
  };

  enabled = [ "Qwen3.6-27B-NVFP4" ];
  default = "Qwen3.6-27B-NVFP4";
}
