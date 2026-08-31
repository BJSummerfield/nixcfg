# Model catalog. Pure data — no pkgs/config/arguments.
# Add a model: write its attrset, add name to `enabled`, rebuild.
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
      # Native context is 262144, and KV is cheap here (only 16 of 64
      # layers are full attention; the rest are linear with constant
      # state). 131072 is the conservative start on the 31GiB card —
      # weights are ~21.8GiB. The pool depends on maxNumBatchedTokens (see
      # below): measured 2026-08-15 via /metrics at 2048 batched tokens:
      # kv_cache_size_tokens=203579; at the current 4096 the estimate is
      # ~170k — re-measure the "GPU KV cache size" startup line after a
      # rebuild. Prefix caching is on (below), so recently-served preambles
      # also sit in the pool — a same-role fan-out shares one cached copy —
      # and maxNumSeqs caps concurrency at 3, so the binding case is still
      # a full wave: 3 x (44k alias window + 8k output) ≈ 160k of the pool.
      # That cap is
      # server-wide, not per session — queued requests hold no KV, blocks
      # are allocated when a sequence is scheduled — so extra pi sessions or
      # a second project buy queueing latency, never memory pressure. A
      # max-length main-session request overlapping two alias requests can
      # transiently overcommit; vLLM resolves that by preempting one
      # sequence, not sustained thrashing.
      maxModelLen = 131072;
      # vLLM enforces input + maxTokens <= maxModelLen per request, but pi
      # only compacts above contextWindow - reserveTokens (16384 default,
      # dist/core/compaction/compaction.js). headroom must therefore be
      # >= maxTokens - 16384 plus margin for token-count drift, or there is
      # a band (maxModelLen - maxTokens .. compaction threshold) where pi
      # sends a request vLLM must 400.
      headroom = 20480;
      maxTokens = 32768;
      # Model-card thinking-mode settings (temperature 1.0, unlike 3.6's 0.6).
      sampling = {
        temperature = 1.0;
        top_p = 0.95;
        top_k = 20;
        min_p = 0.0;
      };
      # pi thinking levels → chat-template reasoning_effort values. The 3.8
      # template accepts only xhigh/medium/low and raises on anything else
      # (it maps high → xhigh itself; we map eagerly so every pi level lands
      # on an accepted value). low is deliberately never sent: on this NVFP4
      # build, low effort degrades multi-turn agentic work enough that the
      # retries cost more than the per-turn speedup buys, so medium is the
      # floor for every pi level. 3.6 has no effort support — no map there,
      # and the unused kwarg is harmless to its template.
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
        # 0.97, not the 0.94 default: the card is dedicated to vLLM (no
        # GUI/compositor co-tenants), and both startup logs measure
        # 30.82/31.34 GiB free at worker start - a ~0.5 GiB
        # driver/context floor outside vLLM's accounting. 0.97 targets
        # 30.40 GiB, leaving ~0.4 GiB slack (1.0 would OOM at startup;
        # 0.98 leaves only ~0.1). The ~0.9 GiB reclaimed vs 0.94 is ~25k
        # tokens of KV at 39.2 KiB/token. vLLM's --kv-cache-memory
        # absolute knob (suggested in the startup log) is more precise
        # but goes stale across model/version changes; the relative form
        # re-derives the pool on every startup.
        gpuMemoryUtilization = 0.97;
        maxNumSeqs = 3;
        # 4096: chunk size trades directly against the KV pool - vLLM
        # profiles peak activation at this size and sizes the pool as the
        # remainder. Fixed budget 8.04 GiB = KV + peak activation, and the
        # pool cost is ~39.2 KiB/token (constant across both measurements).
        # Measured on this stack (v0.26.0, same model/flags): 2048 ->
        # 203,579 tokens (0.45 GiB activation), 8192 -> 135,255 (2.97 GiB).
        # 4096 estimates ~170k from activation interpolated between the two
        # endpoints - confirm the "GPU KV cache size" startup line after a
        # rebuild before trusting the alias math below or bumping this
        # again. Also clears the `block_size <= max_num_batched_tokens`
        # assert that `--mamba-cache-mode align` needs (live attention block
        # size is 1600), and gives the MTP scheduler more headroom than
        # 2048 (which trips the vllm.py:1718 max_num_scheduled_tokens
        # advisory).
        maxNumBatchedTokens = 4096;
        kvCacheDtype = "fp8";
        # recipes.vllm.ai suggests 3 for this model's MTP head
        speculativeTokens = 3;
        # 3.8 moved to the qwen3_coder tool-call format (3.6 was qwen3_xml)
        toolCallParser = "qwen3_coder";
        reasoningParser = "qwen3";
        # Prefix caching is auto-disabled by vLLM for this hybrid-attention
        # architecture; opting in needs the explicit flag plus
        # `--mamba-cache-mode align` (wired in llama-swap.nix): the
        # linear-attention state is checkpointed at the same block
        # boundaries as the attention KV, so a shared prefix's state is
        # cached once instead of re-run per lane. `align` is vLLM's default
        # mode when prefix caching is on for mamba hybrids; we pass it
        # explicitly to pin the behavior. `align` also asserts
        # block_size <= max_num_batched_tokens (live block size 1600) -
        # 4096 clears it with headroom. MTP spec decoding is compatible
        # upstream since the align-mode re-enable (the old bug was draft
        # tokens corrupting the stored mamba state); we don't use async
        # scheduling. On because a same-role fan-out then shares one cached
        # copy of the preamble instead of three - the biggest single win
        # for the wave math below. Watch for 3.6's failure signature
        # (incoherent rewrite loops on long sessions): if it reappears, the
        # A/B is this flag first, then speculativeTokens second.
        enablePrefixCaching = true;
      };

      # Aliases share the running instance — no model swap. Sized against
      # the pool above, not against the compaction win alone: pi compacts
      # past contextWindow - 16384 reserve, so 45056 gives a fan-out
      # subagent 28,672 tokens of working room.
      #
      # The binding case is a full-width wave rather than the average, and
      # a lane can hold its declared window plus its output allowance:
      # 3 x (45056 + 8192) = 159,744 against the estimated ~170,000-token
      # pool at 4096 batched tokens (~94%, ~96% at the pessimistic end of
      # the estimate - the same margin 196,608 had against the measured
      # 203,579 pool at 2048). 57344 would be 196,608, a ~15% overcommit
      # at 4096, which vLLM resolves by preempting a sequence and
      # re-prefilling it later. If the measured pool lands under 166k, step
      # down to 43008 (153,600 wave). Prefix caching is on, so a same-role
      # fan-out shares one cached copy of the preamble instead of three;
      # 44k stays the sizing that fits a full wave, and the fallbacks if
      # the measurement or output quality says otherwise are 43008 and
      # flipping the flag off.
      #
      # Rename rather than editing the number in place: llama-swap's
      # aliases list and pi's model id have to move together, and a stale
      # id then fails loudly instead of quietly serving the wrong window.
      aliases."Qwen3.8-27B-NVFP4-44k" = {
        displayName = "Qwen3.8 27B NVFP4 44k budget (redtruck)";
        contextWindow = 45056;
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

  # 3.8 proved out; 3.6 is out of `enabled` now, which drops it from
  # llama-swap, pi, and the weight fetches. Its catalog entry (hashes and
  # tuning) stays, so re-enabling it is a one-line change if a fallback
  # is ever wanted again.
  enabled = [ "Qwen3.8-27B-NVFP4" ];
  default = "Qwen3.8-27B-NVFP4";
}
