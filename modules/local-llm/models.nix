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
      # Native context is 262144, and KV is cheap here (only 16 of 64 layers
      # are full attention; the rest are linear with constant state).
      #
      # 102400, down from 131072, and it costs nothing. pi cannot structurally
      # send more than `contextWindow - 4096`: clampMaxTokensToContext in
      # @earendil-works/pi-ai caps max_tokens at
      # `contextWindow - estimate - CONTEXT_SAFETY_TOKENS(4096)`, so with a
      # 98304 window the largest request that can exist is 94,208 tokens. The
      # 28,672 tokens this removes described requests pi could never make.
      #
      # What they cost was concurrency. vLLM reports
      # `kv_cache_max_concurrency = kv_cache_size_tokens / max_model_len`, and
      # sizes scheduling against it. Measured on redtruck 2026-09-01 with
      # vision on (pool 163,502):
      #   @131072 -> 1.25x   (below maxNumSeqs, i.e. structurally overcommitted)
      #   @102400 -> 1.60x
      # Text-only for reference was 185,122, so 1.41x and 1.81x.
      #
      # 102400 - 4096 headroom keeps contextWindow at exactly 98304, unchanged,
      # so no pi behaviour moves. The three numbers must travel together:
      # settings.nix derives contextWindow as maxModelLen - headroom, so
      # editing either alone silently moves pi's window.
      #
      # There is no "full wave must fit" invariant. vLLM resolves overcommit by
      # preempting and re-prefilling, which is latency; the old sizing paid for
      # that in truncated reviews, which is correctness.
      #
      # Do not size anything off an interpolation. The pool is whatever the
      # "GPU KV cache size" startup line says, and it is only trustworthy from
      # a clean start - see the peak-activation note under maxNumSeqs.
      maxModelLen = 102400;
      # vLLM enforces input + maxTokens <= maxModelLen per request, but pi
      # only compacts above contextWindow - reserveTokens (16384 default,
      # dist/core/compaction/compaction.js). headroom must therefore be
      # >= maxTokens - 16384 plus margin for token-count drift, or there is
      # a band (maxModelLen - maxTokens .. compaction threshold) where pi
      # sends a request vLLM must 400.
      #
      # The rule above is wrong, and this is the correction. pi does not send
      # `input + maxTokens` blindly: clampMaxTokensToContext shrinks max_tokens
      # to `contextWindow - estimate - 4096` on every request, so the largest
      # total it can ever emit is `contextWindow - 4096` regardless of what
      # maxTokens says. headroom therefore has nothing to do with maxTokens.
      #
      # What headroom actually buys is drift margin between pi's token estimate
      # and vLLM's count, on top of the 4096 pi already reserves internally.
      # 4096 here means vLLM's ceiling is 102400 while pi's largest possible
      # request is 94,208 - 8,192 tokens of slack, twice what the old 32768
      # was really providing.
      #
      # 32768 was also sold as protecting the band between pi's compaction
      # threshold and vLLM's ceiling. It cannot: that band is
      # `reserveTokens - 4096` = 12,288 tokens wide and depends only on pi's
      # settings.compaction.reserveTokens, which nothing in this repo sets.
      # Raising headroom does not narrow it by a single token. Fixing that is
      # a pi-side change, not one here.
      headroom = 4096;
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
      # Vision. Unsloth did NOT strip the tower - config.json carries
      # "language_model_only": false, an image_token_id, a qwen3_5_vision
      # vision_config, and 110 model.visual.* entries in quantization_config's
      # ignore list, so the encoder ships unquantized in bf16 alongside the
      # NVFP4 language model. Omitting this block serves text-only and does not
      # load it at all.
      #
      # 1280x800 is a browser viewport - this exists for UI verification
      # screenshots, which is the use that motivated it. At patch_size 16 and
      # spatial_merge_size 2 each token covers 1024 px, so that is ~1000 image
      # tokens and ~4000 ViT patches. Raising it is quadratic in the encoder's
      # attention: 16MP would be ~62,500 patches, which is what OOMed startup
      # back when no limit was set.
      #
      # count is a per-PROMPT budget, not a per-message or per-turn one, and a
      # chat client resends the whole conversation every turn. So this number is
      # really "images one session may accumulate before it dies": the first
      # request carrying count+1 of them fails
      #
      #   400 BadRequestError: At most N image(s) may be provided in one prompt.
      #
      # and every later request fails identically, because the history that
      # tripped it is resent each turn. The user's next message 400s, and so
      # does the compaction that would have evicted the images. There is no
      # recovery from inside the session.
      #
      # It was 1, on the reasoning that "a second concurrent screenshot is not a
      # use we have". Concurrency was the wrong axis - two `read` calls fourteen
      # seconds apart, one image each, locked a session on 2026-09-01.
      #
      # 4 is cheap because the two costs scale differently. The vision tower is
      # 0.86 GiB of weights, paid in full the moment this block exists at all
      # and flat in count; only the profiling hint scales, and that measured
      # 0.02 GiB for the first image (~500 tokens of pool at ~39.2 KiB/token).
      # So 1 -> 4 is on the order of 1% of the pool, against a failure mode that
      # ends the session. Confirm rather than trust the extrapolation: read the
      # "GPU KV cache size" startup line, or vllm:cache_config_info's
      # kv_cache_size_tokens, before and after.
      #
      # Runtime cost is separate and self-limiting: at 1280x800 each image is
      # ~1000 context tokens, so 4 is ~4k of a 98,304 window.
      vision = {
        maxImages = 4;
        width = 1280;
        height = 800;
      };

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
        # 3, up from 2. The old note claimed this workload never runs wider
        # than two, citing ~441s of 2-wide overlap in run-history.jsonl. That
        # dataset predates the pi-subagents fan-out and no longer describes the
        # traffic: measured server-side over 1000 consecutive requests,
        # 55% arrive with >=3 already in flight, and the tail reaches 16.
        #
        # The cost curve has its knee at exactly the third request - the first
        # one that has to queue behind a cap of 2 (seconds per 1k output
        # tokens, from llama-swap's per-request log):
        #   1 in flight   9.7      <- alone
        #   2 in flight   9.8      <- batching the second lane is free
        #   3 in flight  12.4      +27%
        #   4 in flight  18.4      +89%
        #   >=6          34.9      +260%, with queue waits to 480s
        #
        # 3, not the 4 an earlier plan proposed. The measured knee justifies
        # letting the third request run; 4 was extrapolation, and vision has
        # since taken the pool from 185,122 to 163,502 tokens, so there is less
        # room to be wrong with. Raise to 4 only after watching
        # vllm:num_preemptions_total per request - baseline is already ~1.0,
        # i.e. preemption is not something the low cap was preventing.
        #
        # This is a scheduler cap, not a reservation: nothing is allocated by
        # raising it, and vLLM preempts if the pool runs short. Whether 3 lanes
        # fit depends on the marginal cost of a lane, not the mean request -
        # 78% of prompt tokens are prefix-cache hits, so lanes share blocks and
        # cost far less than 60k each.
        #
        # Read the pool from a clean start only. Peak-activation profiling
        # measured 1.03 GiB and 3.12 GiB on identical configs minutes apart
        # (free memory identical both times, 30.82/31.34 GiB), and the pool is
        # sized as the remainder - so a startup that races another engine's
        # teardown reports a pool 40% too small. vllm-service.nix's health
        # poll now bails on a dead engine, which removes the cause we know of.
        maxNumSeqs = 3;
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
