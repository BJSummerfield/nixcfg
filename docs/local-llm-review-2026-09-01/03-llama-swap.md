# llama-swap: keep or drop?

**Verdict: keep it — but for the opposite reason you have it.** It is no longer doing
model swapping, and it never really was. It is currently your entire observability layer,
and this review would not have been possible without it.

## What it is actually doing today

`enabled = [ "Qwen3.8-27B-NVFP4" ]`, one model, no aliases left after PR #148,
`ttl = null` so the container is never unloaded. The swap feature — the thing it is named
for — is dormant.

What it *is* doing:

| Capability | Used? | Replaceable by? |
| --- | --- | --- |
| Model swapping / eviction | **no** — one model, `ttl = null` | n/a |
| Lazy start + 900 s health-check wait | marginally — never unloads once up | a systemd unit with a readiness probe |
| Alias rewrite (`useModelName`) | **no** — no aliases since PR #148 | n/a |
| OpenAI endpoint on the tailnet | yes | vLLM serves `/v1` natively |
| `GET /upstream/<model>/metrics` | **yes, critically** | direct scrape, if you re-plumb the network |
| `GET /api/metrics/activity` | **yes, critically** | nothing in vLLM does this |
| `GET /logs`, `/running` | yes | `journalctl`, `podman logs` |
| Model list for Open WebUI | yes | vLLM's `/v1/models` |

## The two things that would actually be lost

### `/upstream/<model>/metrics`

vLLM binds to `192.168.100.24:5800` on the host end of the container veth. Nothing on the
tailnet can reach it. llama-swap proxies it, and that proxy is the only reason §2–§5 of
`01-measurements.md` exist: KV pool size, preemption count, prefix-cache hit rate,
queue/prefill/decode split, MTP acceptance per draft position.

Every tuning decision recorded in `models.nix` depends on numbers from this endpoint, and
until now nobody was reading it. It answered, in one scrape, three questions the comments
in that file have been guessing at for weeks.

### `/api/metrics/activity`

A rolling 1,000-request history with per-request input tokens, output tokens, and
`duration_ms`, server-side. vLLM has no equivalent — its Prometheus histograms are
aggregates, so you cannot reconstruct a concurrency-vs-latency curve from them. The entire
`maxNumSeqs` finding came out of this endpoint. Rebuilding it means writing a logging
proxy, which is what llama-swap already is.

Caveat: `cache_tokens`, `draft_tokens`, `prompt_per_second` and `tokens_per_second` all
read `-1`, because llama-swap reads them out of the response `usage` block and vLLM does
not populate them (see `02-vllm-and-model.md` §5). So the activity log gives you tokens
and wall time, not rates.

## The real costs of keeping it

1. **`/v1/models` is lossy.** It reports `{"id":"Qwen3.8-27B-NVFP4","max_model_len":null,
   "owned_by":"llama-swap"}` — the upstream's real `max_model_len` is dropped. Harmless
   given the nix config is hand-authored, but it means a client cannot self-configure.
2. **`--rm` means logs die with the container.** `podman logs vllm-qwen3.8-27b-nvfp4` works
   on redtruck while it is up, and llama-swap buffers a window at `/logs`, but nothing is
   in the journal, nothing survives a restart, and nothing is time-correlatable with the
   agent sessions after the fact.
3. **`/metrics` is a red herring.** llama-swap's own `/metrics` is host CPU/memory/network
   only — zero `vllm:` families, no GPU. It looks like an observability endpoint and is not
   one. The real one is `/upstream/<model>/metrics`.
4. One more process, one more config generator (`llama-swap.nix`, 101 lines) between you
   and the engine.

## On "sometimes it'd be nice to query the vLLM logs directly"

You already can, two ways, and neither requires removing llama-swap:

```bash
# on redtruck, host side — llama-swap launches the container on the host podman socket
podman logs -f vllm-qwen3.8-27b-nvfp4

# from anywhere on the tailnet
curl -s https://llm.mist-gamma.ts.net:8443/logs
curl -s https://llm.mist-gamma.ts.net:8443/upstream/Qwen3.8-27B-NVFP4/metrics
```

The gap is not access, it is **persistence**. `--rm` plus no journald driver means the
startup lines every `models.nix` comment tells you to read ("GPU KV cache size",
"Setting attention block size", the `max_num_scheduled_tokens` advisory) are gone the
moment the container is replaced. That is worth fixing on its own, independently of the
llama-swap question.

## When dropping it would become right

If the catalog goes to exactly one model *permanently* — 3.6 deleted rather than parked,
no intent to A/B a second engine — then llama-swap's remaining value is observability
alone, and that is better served by a real Prometheus scrape plus a systemd unit. But
today the catalog deliberately keeps 3.6's entry "so re-enabling it is a one-line change
if a fallback is ever wanted again", and §3 of `02-vllm-and-model.md` says you are about
to want exactly that kind of A/B. Removing the swapper right before an engine bump that
may need rolling back is the wrong order of operations.
