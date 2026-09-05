# Model catalog. Pure data — no pkgs/config/arguments.
# Add a model: write its attrset, add name to `enabled`, rebuild.
# Tuning rationale behind the numbers below: docs/local-llm.md.
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
        # MTP head, loaded by --speculative-config (see the vllm block). vLLM
        # resolves the draft model to the target's own directory when the
        # speculative config omits `model`, so this file is found at /model
        # alongside the target weights and needs no separate mount or fetch.
        "model_mtp.safetensors" = "sha256-HYJoqoWs4JOlYePntjudOQ2sHNVakM1VtexQnDydqf4=";
        "model.safetensors.index.json" = "sha256-QpQw4bnmWyy5jv+M0QoG5woJzuicSEh6ORRoSutt9X8=";
        "preprocessor_config.json" = "sha256-JyJUUKycZSmHLuGST8sJYv9WNINPgXBA9EQRgRb05RY=";
        "tokenizer.json" = "sha256-BrlQk1LSr1A4GrIkfgg7gNMtXAq6kcJyyp/3Kbag5SM=";
        "tokenizer_config.json" = "sha256-Up8wAYw23KU4fJm17fNoKH84bywy03kKpxQZVrxRGfo=";
        "video_preprocessor_config.json" = "sha256-d2ivJ8H6+pzJARwdwgBn4D+JFeA7Y1BFUOEdUGaYbRM=";
        "vocab.json" = "sha256-zpm0yymD0RiAbOCot3ejWwk+IAClA+veJYUyhMnfoAM=";
      };

      reasoning = true;
      # Sized for concurrency (native context is 262144), and coupled to
      # headroom below - settings.nix derives pi's contextWindow as
      # maxModelLen - headroom. See docs/local-llm.md for the full derivation.
      maxModelLen = 102400;
      # Drift margin between pi's token estimate and vLLM's count, not a
      # safety margin on maxTokens. See docs/local-llm.md.
      headroom = 4096;
      maxTokens = 32768;
      # Model-card thinking-mode settings (temperature 1.0, unlike 3.6's 0.6).
      sampling = {
        temperature = 1.0;
        top_p = 0.95;
        top_k = 20;
        min_p = 0.0;
      };
      # pi thinking levels → chat-template reasoning_effort. The 3.8 template
      # accepts only xhigh/medium/low and raises on anything else. low is
      # deliberately never sent: on this NVFP4 build it degrades multi-turn
      # agentic work enough that the retries cost more than the speedup buys,
      # so medium is the floor for every level.
      thinkingLevels = {
        minimal = "medium";
        low = "medium";
        medium = "medium";
        high = "xhigh";
        xhigh = "xhigh";
        max = "xhigh";
      };
      # count is a per-PROMPT budget (a chat client resends the whole
      # conversation every turn), not per-message: it is really "images one
      # session may accumulate before every subsequent request 400s and
      # compaction can no longer evict them." It was 1 and locked a session on
      # 2026-09-01 (AGENTS.md is generated from this number); 8 -> 3 gives MTP
      # room. width/height are memory-profiling hints, not a runtime cap - they
      # scale quadratically in the encoder's attention. Full incident and the
      # "put this back first" guidance: docs/local-llm.md.
      vision = {
        maxImages = 3;
        width = 1280;
        height = 800;
      };

      vllm = {
        # 0.95, what the other two models in this catalog use, OOMs with MTP on:
        # FlashInfer autotune wants 272 MiB after KV allocation succeeds and
        # finds 73 MiB. 0.955 works paired with maxNumBatchedTokens 2048 below - the pair moves together,
        # raising the batch without lowering this reintroduces the OOM. Fuller
        # derivation, and the --kv-cache-memory byte-pin alternative (verified
        # 138,693 tokens, not used because it doesn't survive an image/driver
        # change): docs/local-llm.md.
        gpuMemoryUtilization = 0.955;
        # A scheduler cap, not a reservation. Pool-per-lane against a real
        # 64-68k turn, not the lane count alone, is what decides this: measured
        # pools with MTP on run 105k-139k, and pi's compaction ceiling per turn
        # is 81,920 - two lanes need ~164k to cover it, three is not close.
        # `Maximum concurrency ... N.NNx` on the startup line is pool /
        # maxModelLen, NOT the lane count - do not read it as one. Measured
        # pools, the prefix-caching argument for revisiting 3, and the
        # preemption-rate signal to watch: docs/local-llm.md.
        maxNumSeqs = 2;
        # Trades directly against the KV pool (vLLM profiles peak activation at
        # this chunk size and sizes the pool as the remainder): 4096 -> 1.25
        # GiB peak / 104,992 tokens at 0.93; 2048 -> 0.97 GiB / 112,769 tokens,
        # which is what pays for gpuMemoryUtilization 0.955 above. Must stay >=
        # the "Setting attention block size to N tokens" startup line (measured
        # 1600 at K=3) or the `--mamba-cache-mode align` assert fails. Only
        # trust a pool reading from a clean start - a startup racing another
        # engine's teardown reports a pool 40% too small. Full tradeoff:
        # docs/local-llm.md.
        maxNumBatchedTokens = 2048;
        # Never pair with --calculate-kv-scales: that combination, not fp8
        # itself, is what the upstream corruption reports have in common.
        kvCacheDtype = "fp8";
        # MTP, back on after #156 took it off. Measured 3.04 accepted tokens
        # per decode step on a stack that is 93% decode-bound, which is why
        # removing it doubled TPOT (9.98ms -> 18.72ms). The four upstream
        # defects this is actually gated on (prefix caching is NOT exposed to
        # any of them, so it is not the next thing to try if corruption
        # returns), the measured KV cost (-43%, 211,911 -> 120,546 tokens),
        # and the acceptance-rate evidence for reconsidering the count:
        # docs/local-llm.md and docs/ninfer-vs-vllm-2026-09-03/{03,05,06}.
        speculativeTokens = 3;
        # qwen3_xml, not the qwen3_coder format 3.8 nominally moved to:
        # qwen3_coder does not stream arguments (reads as a hang) and emits
        # unbounded garbage on long inputs containing a tool call.
        toolCallParser = "qwen3_xml";
        reasoningParser = "qwen3";
        # Redundant since #50991 (default-on for mamba models in 0.28.0), kept
        # explicit to survive a future default flip. Prefill is nearly free
        # here (82.2% cache hits) and this is confirmed to survive MTP despite
        # a startup warning to the contrary - see docs/local-llm.md for the
        # measurement that overrides the warning. If corruption returns,
        # speculativeTokens comes out first and this stays.
        enablePrefixCaching = true;
      };

      # No alias. If a second budget is ever wanted, add it as an alias and
      # rename rather than editing a number in place - the alias list and pi's
      # model id have to move together, so a stale id then fails loudly
      # instead of quietly serving the wrong window.
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
      # vLLM enforces input + maxTokens <= maxModelLen per request, but pi
      # only compacts above contextWindow - reserveTokens (16384 default,
      # dist/core/compaction/compaction.js). headroom must therefore be
      # >= maxTokens - 16384 plus margin for token-count drift, or there is
      # a band (maxModelLen - maxTokens .. compaction threshold) where pi
      # sends a request vLLM must 400. 8192 left an 8k band and a final
      # review died in it at exactly maxModelLen + 1 tokens.
      headroom = 20480;
      maxTokens = 32768;
      sampling = {
        temperature = 0.6;
        top_p = 0.95;
        top_k = 20;
        min_p = 0.0;
      };

      vllm = {
        # 0.95 like the 3.8 entry: measured safe on this card, which is dedicated
        # to vLLM with no compositor co-tenant. Parked entries, so this is
        # consistency for a future re-enable rather than a live change.
        gpuMemoryUtilization = 0.95;
        # 3 for parallel subagent concurrency without outgrowing the KV pool
        maxNumSeqs = 3;
        maxNumBatchedTokens = 2048;
        kvCacheDtype = "fp8";
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

      vllm = {
        # 0.95 like the 3.8 entry: measured safe on this card, which is dedicated
        # to vLLM with no compositor co-tenant. Parked entries, so this is
        # consistency for a future re-enable rather than a live change.
        gpuMemoryUtilization = 0.95;
        maxNumSeqs = 2;
        maxNumBatchedTokens = 2048;
        # fp8 kv caused incoherent output on this MoE — using default dtype.
        kvCacheDtype = "auto";
        toolCallParser = "qwen3_xml";
        reasoningParser = "qwen3";
      };
    };
  };

  # 3.8 proved out; 3.6 is out of `enabled` now, which drops it from
  # llama-swap, pi, and the weight fetches. Its catalog entry (hashes and
  # tuning) stays, so re-enabling it is a one-line change if a fallback
  # is ever wanted again.
  enabled = [ "Qwen3.8-27B-NVFP4" ];
  default = "Qwen3.8-27B-NVFP4";
}
