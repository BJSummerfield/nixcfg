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
      # Native context is 262144; this is sized for concurrency, not reach.
      # vLLM reports kv_cache_max_concurrency = pool / maxModelLen and schedules
      # against it, so a larger window structurally overcommits the lanes.
      #
      # maxModelLen and headroom travel together: settings.nix derives pi's
      # contextWindow as maxModelLen - headroom, so editing either alone
      # silently moves pi's window. Sizing rationale and the measured pool
      # numbers are in docs/local-llm-review-2026-09-01/.
      maxModelLen = 102400;
      # Drift margin between pi's token estimate and vLLM's count, and nothing
      # else. pi's clampMaxTokensToContext already shrinks max_tokens to
      # `contextWindow - estimate - 4096` on every request, so the largest total
      # it can emit is `contextWindow - 4096` whatever maxTokens says - headroom
      # is unrelated to maxTokens. It also cannot protect the band between pi's
      # compaction threshold and vLLM's ceiling: that band is
      # `reserveTokens - 4096` wide and moves only with pi's
      # settings.compaction.reserveTokens.
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
      # Unsloth ships the vision tower unquantized in bf16 alongside the NVFP4
      # language model; omitting this block serves text-only and never loads it.
      # width/height are memory-profiling hints and scale quadratically in the
      # encoder's attention - 16MP OOMed startup when no limit was set.
      #
      # count is a per-PROMPT budget, not per-message, and a chat client resends
      # the whole conversation every turn - so it is really "images one session
      # may accumulate before it dies". The first request carrying count+1 fails
      # with `400 At most N image(s) may be provided in one prompt`, and so does
      # every request after it, including the compaction that would have evicted
      # them. Nothing recovers from inside; under the budget compaction does
      # drop them. It was 1, and two `read` calls fourteen seconds apart locked
      # a session on 2026-09-01. AGENTS.md is generated from this number.
      #
      # 8 -> 3 to give MTP room. Note what this does and does not buy: the
      # startup line reads "profiled with 1 image items of the maximum feature
      # size", so peak activation is set by width/height and not by count, and
      # the encoder cache budget is its own 16384 tokens either way. The saving
      # is therefore small and the cost is concrete - 3 is the number of images
      # a session may accumulate before every subsequent request 400s, which is
      # what made 1 unusable. If a session ever locks that way again, this is
      # the first number to put back, not the last.
      vision = {
        maxImages = 3;
        width = 1280;
        height = 800;
      };

      vllm = {
        # The card is dedicated to vLLM, but ~0.5 GiB of driver/context sits
        # outside vLLM's accounting: 0.97 left only ~0.4 GiB of slack.
        #
        # 0.95 was right until MTP came back and does not fit any more. With
        # speculativeTokens set and maxNumBatchedTokens at 4096 it OOMs at
        # startup - not in KV allocation, which succeeds, but afterwards in
        # FlashInfer autotune, which wants 272 MiB and finds 73 MiB.
        #
        # That is headroom for a warmup pass, not slack. The autotuner runs a
        # max-size forward, so an OOM there is the shape of the first real 64k
        # request - disabling the autotune would move the failure out of boot
        # and into production, which is the wrong direction.
        #
        # 0.955 works because maxNumBatchedTokens came down to 2048 with it:
        # peak activation is 0.97 GiB at 2048 against 1.25 at 4096, and that
        # 0.28 GiB is what buys back the fraction. The pair moves together -
        # raising the batch without lowering this reintroduces the OOM.
        #
        # Deliberately a fraction and not --kv-cache-memory, though the byte
        # form is measurably better and vllm-service.nix still emits it when a
        # model sets kvCacheMemory. 5995147264 was verified here (5.58 GiB,
        # 138,693 tokens, +32%) and it is the thing to reach for if the pool
        # gets tight. It is not the default because the byte count does not
        # travel: vLLM derives it from free memory at boot, so an image bump,
        # a driver change, or anything else resident on the card silently
        # invalidates it, and the failure mode is a box that will not start.
        # A fraction re-derives itself every boot.
        gpuMemoryUtilization = 0.955;
        # A scheduler cap, not a reservation - nothing is allocated by raising
        # it. What it decides is what happens to the request that does not fit:
        # admitted and preempted, or queued. Both wait; only one of them
        # discards a half-built request first.
        #
        # The number that matters is pool per lane against a real turn, not the
        # lane count on its own. Turns measured here run 64-68k, and pi cannot
        # exceed 81,920 because that is where it compacts (contextWindow minus
        # its own reserveTokens), so 81,920 is the ceiling a lane must cover,
        # not maxModelLen. Measured pools, all MTP-on:
        #   104,992 at 0.93 / 4096
        #   112,769 at 0.93 / 2048
        #   138,693 with the byte pin
        # against 211,911 pre-MTP, where 3 lanes gave 70,637 each. Two lanes
        # need ~136k to cover a 68k turn and ~164k to cover the 81,920 ceiling.
        # So 2 is what the pool supports and 3 is not close: a third lane would
        # admit a request the pool cannot hold and preempt something to make
        # room. Operator report from the 3-lane era agrees - rarely actually at
        # 3, and it thrashed when it got there.
        #
        # Do NOT read `Maximum concurrency ... N.NNx` from the startup line as
        # the lane count: that is pool / maxModelLen, and maxModelLen is a
        # per-request ceiling nothing reaches. Divide by the real turn size.
        #
        # The arithmetic above is naive in one direction: prefix caching dedups
        # blocks ACROSS concurrent requests, so subagents sharing a system
        # prompt and repo context do not each pay for it, and true residency
        # can sit under 2 x 64k. That is unmeasured, and it is the only thing
        # that would make 3 viable. Evidence for trying it would be
        # vllm:num_preemptions_total / vllm:request_success_total staying near
        # zero (0.34% now, 99.4% on the last MTP-on soak) while queue time
        # climbs - and it earns its own commit with its own before/after, not a
        # bump in passing.
        maxNumSeqs = 2;
        # Trades directly against the KV pool: vLLM profiles peak activation at
        # this chunk size and sizes the pool as the remainder, so raising it
        # shrinks the pool. Measured on this model, same flags otherwise:
        # 4096 -> 1.25 GiB peak activation and 104,992 tokens at 0.93;
        # 2048 -> 0.97 GiB and 112,769. The 0.28 GiB is what pays for
        # gpuMemoryUtilization 0.955 above, and the two must move together.
        #
        # 2048 is not free. vLLM prints "max_num_scheduled_tokens is set to
        # 2048 based on the speculative decoding settings ... consider
        # increasing max_num_batched_tokens" on every start, because each
        # sequence now needs speculativeTokens+1 decode slots per step rather
        # than one. A cold 64k prefill is also 32 scheduler steps instead of
        # 16. We take that to keep the pool, and the warning is expected rather
        # than actionable.
        #
        # Must stay >= the "Setting attention block size to N tokens" startup
        # line to clear the assert `--mamba-cache-mode align` makes. That line
        # tracks speculative depth - measured 1568 at K=0 and 1600 at K=3 on
        # this model - so 2048 clears 1600 by 448 tokens, which is thinner
        # margin than 4096 had. Re-read it after any speculativeTokens change
        # rather than assuming.
        #
        # Read the pool from the startup line or vllm:cache_config_info, never
        # from an interpolation, and only from a clean start: peak-activation
        # profiling measured 1.03 and 3.12 GiB on identical configs minutes
        # apart, so a startup racing another engine's teardown reports a pool
        # 40% too small.
        maxNumBatchedTokens = 2048;
        # Never pair with --calculate-kv-scales: that combination, not fp8
        # itself, is what the upstream corruption reports have in common.
        kvCacheDtype = "fp8";
        # MTP, back on after #156 took it off. 3 is what recipes.vllm.ai
        # suggests for this model's MTP head, and it measured 3.04 accepted
        # tokens per decode step here - on a stack that is 93% decode-bound,
        # which is why removing it doubled TPOT from 9.98 ms to 18.72 ms.
        #
        # "Draft-token rollback cannot restore a mamba recurrent snapshot" was
        # the reason given for the removal and it is wrong about vLLM. The real
        # exposure is four distinct upstream defects, all of them gated on
        # speculative decoding being on - prefix caching alone is not exposed
        # to any of them, which is why it stays on unconditionally below and is
        # NOT the next thing to try if corruption returns:
        #   M1 #51113 write-path chunk alignment - merged, in v0.28.0.
        #   M2 the drop_eagle_block read-path hole - NO fix merged; nine
        #      competing open PRs, five of which push the opposite way. We do
        #      not patch it, we route around it: disable_eagle_block_drop in
        #      vllm-service.nix means that code path never executes.
        #   M3 #50729 overlapping conv-state copy - merged after v0.28.0,
        #      present in the pinned nightly. Most likely cause of what we saw.
        #   M4 #51571 async accepted-count race - open. Statically gated on
        #      async scheduling, which MTP switches on by default, which is why
        #      vllm-service.nix passes --no-async-scheduling alongside this.
        # What it costs, measured on the first boot that survived: the pool
        # goes 211,911 -> 120,546 tokens at an unchanged 0.95, i.e. -43%. Not
        # the draft head, which is nearly free (weights 21.97 -> 22.01 GiB) -
        # it is the mamba state, 2+P pages per request becoming 5+P across
        # three groups, because num_speculative_blocks == speculativeTokens.
        # So this number is a KV lever as much as a speed one, and 3 -> 2 gives
        # a page per request per group back.
        #
        # Whether that trade is worth taking is an open measurement, not a
        # guess: the first probe reported per-position acceptance of 0.667,
        # 0.333, 0.333, which would make positions 2 and 3 nearly free to give
        # up - but that was 6 drafts. Read
        # vllm:spec_decode_num_accepted_tokens_total / _num_draft_tokens_total
        # over real traffic against the 67.9% this stack measured pre-#156
        # before touching it.
        #
        # Mechanism detail in docs/ninfer-vs-vllm-2026-09-03/03; field evidence
        # for each patch in 05; the deploy and rollback runbook in 06.
        speculativeTokens = 3;
        # qwen3_xml, not the qwen3_coder format 3.8 nominally moved to:
        # qwen3_coder does not stream arguments (reads as a hang) and emits
        # unbounded garbage on long inputs containing a tool call.
        toolCallParser = "qwen3_xml";
        reasoningParser = "qwen3";
        # Redundant since #50991 turned prefix caching on by default for mamba
        # models in 0.28.0, and kept explicit anyway: it documents intent and
        # survives a default flip in either direction. It is the reason prefill
        # is nearly free here - 82.2% of prompt tokens are cache hits - and no
        # upstream mechanism makes it a corruption suspect on its own. If
        # corruption returns, speculativeTokens comes out first and this stays.
        #
        # It survives MTP, which was the open question this whole change rested
        # on. Startup logs a warning that "prefix-cache reuse across requests
        # will be disabled" because no KV group can be annotated as the draft
        # group; it fires on use_eagle() regardless of disable_eagle_block_drop
        # and, for us, it is wrong. Measured 2026-09-04, MTP on, two identical
        # 30,058-token requests: the second served 28,800 tokens from cache,
        # 95.8%, the miss being exactly the trailing partial block
        # (30,058 = 18 x 1600 + 1,258). Trust that number over the warning, and
        # re-run the probe rather than the warning after any engine bump.
        enablePrefixCaching = true;
      };

      # No alias. A 44k fan-out budget lived here and was deleted rather than
      # resized: it compacted children at 28,672 tokens while workers run
      # 64-68k input per turn, and its 8192 maxTokens truncated review verdicts
      # at stopReason "length". If a second budget is ever wanted, add it as an
      # alias and rename rather than editing a number in place - the alias list
      # and pi's model id have to move together, so a stale id then fails
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
