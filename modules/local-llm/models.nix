{
  provider = "redtruck";
  baseUrl = "https://llm.mist-gamma.ts.net:8443/v1";

  models = {
    "Qwen3.8-27B-NVFP4" = {
      displayName = "Qwen3.8 27B NVFP4 (redtruck)";
      repo = "unsloth/Qwen3.8-27B-NVFP4";
      files = {
        "chat_template.jinja" = "sha256-EoJ/JLdC6k6AzcEtvPliIicFa595clKjFJJj1Pmqrc4=";
        "config.json" = "sha256-Gzxxho0SmeUt9vyQfesgLVEyse8Pcqrg720VGF3VOlw=";
        "generation_config.json" = "sha256-0NDtLjfN+v70pQZ9XqJAewX0+1BSbkfACKWyNdUCQPs=";
        "model.safetensors" = "sha256-xHNRLHDqzgfiJW/p/XZZasA+MpW+59VM+3JnZBavzAU=";
        # MTP head — required by llama-swap's speculative-config mtp flag
        "model_mtp.safetensors" = "sha256-HYJoqoWs4JOlYePntjudOQ2sHNVakM1VtexQnDydqf4=";
        "model.safetensors.index.json" = "sha256-QpQw4bnmWyy5jv+M0QoG5woJzuicSEh6ORRoSutt9X8=";
        "preprocessor_config.json" = "sha256-JyJUUKycZSmHLuGST8sJYv9WNINPgXBA9EQRgRb05RY=";
        "tokenizer.json" = "sha256-BrlQk1LSr1A4GrIkfgg7gNMtXAq6kcJyyp/3Kbag5SM=";
        "tokenizer_config.json" = "sha256-Up8wAYw23KU4fJm17fNoKH84bywy03kKpxQZVrxRGfo=";
        "video_preprocessor_config.json" = "sha256-d2ivJ8H6+pzJARwdwgBn4D+JFeA7Y1BFUOEdUGaYbRM=";
        "vocab.json" = "sha256-zpm0yymD0RiAbOCot3ejWwk+IAClA+veJYUyhMnfoAM=";
      };

      reasoning = true;
      # Native context is 262144; KV is cheap (only 16 of 64 layers are
      # full attention, the rest linear with constant state). Measured
      # 2026-08-15 via /metrics: kv_cache_size_tokens=203579 (~1.55
      # concurrent full windows). No prefix caching (vLLM auto-disables
      # it for this hybrid-attention model) and maxNumSeqs caps
      # concurrency at 3, so the binding case is a full wave:
      # 3 x (48k alias + 8k output) ≈ 168k; transient overcommit
      # resolves by preemption, not thrashing. 131072 is the
      # conservative start on the 31GiB card (weights ~21.8GiB).
      maxModelLen = 131072;
      # pi compacts above contextWindow - 16384 reserve, so headroom must be
      # >= maxTokens - 16384 plus token-count margin or pi can send a request
      # vLLM must 400.
      headroom = 20480;
      maxTokens = 32768;
      # Model-card thinking-mode settings (temperature 1.0, unlike 3.6's 0.6).
      sampling = {
        temperature = 1.0;
        top_p = 0.95;
        top_k = 20;
        min_p = 0.0;
      };
      # pi thinking levels → reasoning_effort. The 3.8 template accepts only
      # xhigh/medium/low and raises on anything else (it maps high → xhigh),
      # so we map eagerly. low is never sent: on this NVFP4 build it
      # degrades multi-turn agentic work, so medium is the floor. 3.6 has no
      # effort support — the unused kwarg is harmless to its template.
      thinkingLevels = {
        minimal = "medium";
        low = "medium";
        medium = "medium";
        high = "xhigh";
        xhigh = "xhigh";
        max = "xhigh";
      };

      # null ttl: vLLM cold start is minutes
      ttl = null;

      vllm = {
        gpuMemoryUtilization = 0.94;
        maxNumSeqs = 3;
        maxNumBatchedTokens = 2048;
        kvCacheDtype = "fp8";
        # recipes.vllm.ai suggests 3 for this model's MTP head
        speculativeTokens = 3;
        # 3.8 moved to the qwen3_coder tool-call format (3.6 was qwen3_xml)
        toolCallParser = "qwen3_coder";
        reasoningParser = "qwen3";
      };

      # Aliases share the running instance — no model swap. 48k sized from
      # the measured pool: past pi's 16384 compaction reserve, subagents get
      # ~32k working room (the old 32k window forced early compaction).
      aliases."Qwen3.8-27B-NVFP4-48k" = {
        displayName = "Qwen3.8 27B NVFP4 48k budget (redtruck)";
        contextWindow = 49152;
        maxTokens = 8192;
      };
    };

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
      # measured on 31GiB card; drop maxModelLen if pool shrinks
      maxModelLen = 131072;
      # pi compacts above contextWindow - 16384 reserve, so headroom must be
      # >= maxTokens - 16384 plus token-count margin or pi can send a request
      # vLLM must 400. 8192 left an 8k band that a final review died in at
      # maxModelLen + 1 tokens.
      headroom = 20480;
      maxTokens = 32768;
      sampling = {
        temperature = 0.6;
        top_p = 0.95;
        top_k = 20;
        min_p = 0.0;
      };

      # null ttl: vLLM cold start is minutes
      ttl = null;

      vllm = {
        gpuMemoryUtilization = 0.94;
        # 3 for parallel subagent concurrency without outgrowing the KV pool
        maxNumSeqs = 3;
        maxNumBatchedTokens = 2048;
        kvCacheDtype = "fp8";
        speculativeTokens = 2;
        toolCallParser = "qwen3_xml";
        reasoningParser = "qwen3";
      };

      # Prefix caching off: caused incoherent rewrite loops on long sessions.

      # Aliases share the running instance — no model swap.
      aliases."Qwen3.6-27B-NVFP4-32k" = {
        displayName = "Qwen3.6 27B NVFP4 32k budget (redtruck)";
        contextWindow = 32768;
        maxTokens = 8192;
      };
    };

    # Not in `enabled` — nothing is fetched.
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
      sampling = {
        temperature = 0.6;
        top_p = 0.95;
        top_k = 20;
        min_p = 0.0;
      };
      ttl = 3600;

      vllm = {
        gpuMemoryUtilization = 0.94;
        maxNumSeqs = 2;
        maxNumBatchedTokens = 2048;
        # fp8 kv caused incoherent output on this MoE — using default dtype.
        kvCacheDtype = "auto";
        speculativeTokens = 2;
        toolCallParser = "qwen3_xml";
        reasoningParser = "qwen3";
      };
    };
  };

  # 3.8 proved out; 3.6 is out of `enabled`, which drops it from
  # llama-swap, pi, and the weight fetches. Its catalog entry (hashes and
  # tuning) stays, so re-enabling is a one-line fallback if wanted again.
  enabled = [ "Qwen3.8-27B-NVFP4" ];
  default = "Qwen3.8-27B-NVFP4";
}
