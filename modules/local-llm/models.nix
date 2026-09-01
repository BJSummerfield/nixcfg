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
      # kv_cache_size_tokens=203579; at 4096 the interpolation was ~170k, but
      # that line was fitted before prefix caching and --mamba-cache-mode
      # align, which page the linear-attention state out of the same pool —
      # so it does not describe this config. 0.95 (down from 0.97) gives back
      # a further ~0.63GiB ≈ ~17k tokens. Nothing here is sized off that
      # estimate any more: read the "GPU KV cache size" startup line.
      #
      # There is no longer a "full wave must fit" invariant. It cannot hold
      # at any window big enough to be useful (2 x (98304 + 32768) = 262144),
      # and it was only ever satisfied by starving children — the alias it
      # justified made a worker compact on nearly every turn. vLLM resolves
      # overcommit by preempting and re-prefilling, which is latency; the old
      # sizing paid for that in truncated reviews, which is correctness.
      # maxNumSeqs is the actual pool guard now (see below).
      maxModelLen = 131072;
      # vLLM enforces input + maxTokens <= maxModelLen per request, but pi
      # only compacts above contextWindow - reserveTokens (16384 default,
      # dist/core/compaction/compaction.js). headroom must therefore be
      # >= maxTokens - 16384 plus margin for token-count drift, or there is
      # a band (maxModelLen - maxTokens .. compaction threshold) where pi
      # sends a request vLLM must 400.
      #
      # 32768, not the bare 16384 the rule requires: subagents run on this
      # entry now, so the slack past the compaction threshold has to absorb a
      # large tool result mid-turn, not just token-count drift. Window 98304,
      # threshold 81920, and 81920 + 32768 = 114688 against the 131072 ceiling
      # leaves 16384. Measured worker footprint is 64-68k input/turn
      # (~/.pi/agent/sessions/*/subagent-artifacts/*_meta.json), so a worker
      # clears the threshold without compacting at all; on the retired 44k
      # alias it compacted on nearly every turn.
      headroom = 32768;
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

      vllm = {
        # 0.95, not the 0.94 default and not the 0.97 tried before: the card
        # is dedicated to vLLM (no GUI/compositor co-tenants), and both
        # startup logs measure 30.82/31.34 GiB free at worker start - a
        # ~0.5 GiB driver/context floor outside vLLM's accounting. 0.97
        # targets 30.40 GiB and left only ~0.4 GiB slack; 0.95 targets
        # ~29.77 GiB and buys back a real margin for ~0.63 GiB of pool
        # (~17k tokens at 39.2 KiB/token). vLLM's --kv-cache-memory absolute
        # knob (suggested in the startup log) is more precise but goes stale
        # across model/version changes; the relative form re-derives the pool
        # on every startup.
        gpuMemoryUtilization = 0.95;
        # 2, not 3: the pool guard is here now that no client-side window
        # pretends to be one. Measured worker footprint is 64-68k input/turn,
        # so 2 concurrent lanes are ~136k against the pool and 3 are ~204k.
        # 3 was also buying concurrency this workload does not use - the only
        # real overlap in run-history.jsonl is two researchers (ts 1788216982
        # +546s and 1788217087 +651s, ~441s of genuine 2-wide). The cap is
        # server-wide, not per session, and queued requests hold no KV, so a
        # third caller buys queueing latency rather than memory pressure.
        maxNumSeqs = 2;
        # 4096: chunk size trades directly against the KV pool - vLLM
        # profiles peak activation at this size and sizes the pool as the
        # remainder. Fixed budget 8.04 GiB = KV + peak activation, and the
        # pool cost is ~39.2 KiB/token (constant across both measurements).
        # Measured on this stack (v0.26.0, same model/flags): 2048 ->
        # 203,579 tokens (0.45 GiB activation), 8192 -> 135,255 (2.97 GiB).
        # 4096 estimated ~170k from activation interpolated between the two
        # endpoints, but both endpoints predate prefix caching + align, so
        # read the "GPU KV cache size" startup line rather than the
        # interpolation. Raising this shrinks the pool, so if a startup
        # advisory asks for a bigger batch, prefer lowering maxNumSeqs -
        # same constraint, opposite sign on the pool. Also clears the
        # `block_size <= max_num_batched_tokens` assert that
        # `--mamba-cache-mode align` needs (live attention block size is
        # 1600), and gives the MTP scheduler more headroom than 2048 (which
        # trips the vllm.py:1718 max_num_scheduled_tokens advisory).
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
        # copy of the preamble instead of one per lane. Watch for 3.6's
        # failure signature (incoherent rewrite loops on long sessions): if
        # it reappears, the A/B is this flag first, then speculativeTokens
        # second.
        enablePrefixCaching = true;
      };

      # No alias. There was a 44k fan-out budget here; it was deleted rather
      # than resized, because it never did what its name implied. llama-swap
      # rewrites an alias back via useModelName, so the smaller contextWindow
      # never reached vLLM at all - it was client-side self-restraint, not a
      # pool guarantee, and it cost real work on every run to probabilistically
      # relieve a pool nobody had measured since. Concretely, at 45056 pi
      # compacted a child past 28,672 tokens while workers actually run
      # 64-68k input/turn, and its 8192 maxTokens both truncated xhigh review
      # verdicts at stopReason "length" and capped pi's own compaction summary
      # (min(0.8 * 16384, maxTokens), shared with the summarizer's reasoning).
      #
      # If a genuine second budget is ever wanted, add it back as an alias and
      # rename rather than editing a number in place: llama-swap's aliases list
      # and pi's model id have to move together, and a stale id then fails
      # loudly instead of quietly serving the wrong window.
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

      vllm = {
        # 0.95 like the 3.8 entry: measured safe on this card, which is dedicated
        # to vLLM with no compositor co-tenant. Parked entries, so this is
        # consistency for a future re-enable rather than a live change.
        gpuMemoryUtilization = 0.95;
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
