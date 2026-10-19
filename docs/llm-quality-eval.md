# Measuring the local LLM's quality across engine settings

Two engine settings can differ between the redtruck configurations:

- **KV cache format** (`kvDtype`: `bf16`, `fp8`, `k8v4`, ...). Lower precision
  stores the model's view of the context less exactly. The error builds up with
  context length, so long agent sessions are where any loss shows.
- **Speculative decoding** (`spec`: `mtp` or `dflash2`). The draft tokens are
  checked by the full model, so by design it should not change the output.
  The test here is that the implementation really is lossless.

The weights are NVFP4 in every configuration.

There are three tests, from most to least precise:

| Test | Measures | Where it runs | Engine |
|---|---|---|---|
| `ninfer-ppl` | KV format only: perplexity on fixed text, including code and your own agent transcripts | local-llm container | stopped |
| `ninfer-greedy-check` | Whether a setting changes what the agent does next on real agent prompts, at temperature 0 | devbox | running, one config at a time |
| BFCL multi-turn + IFBench | End-to-end tool use and instruction following | devbox | running, one config at a time |

## 0. Build the corpus from pi transcripts (devbox)

```sh
nix run ~/projects/nixcfg#ninfer-pi-corpus -- --out ~/ninfer-eval/pi-corpus
```

This renders the most recent Qwen3.8 pi sessions (orchestrators and
subagents, split at compactions) through the model's own chat template. It
writes `manifest.json` plus about 4 MiB of streams, and `prompts.jsonl` with 40
real agent prompts for the greedy check. The transcripts contain whatever the
sessions saw, so keep the output on the machine.

Copy the corpus to where the local-llm container can read it (on redtruck):

```sh
sudo mkdir -p /var/lib/local-llm/ninfer-eval
sudo cp -r /var/lib/nixos-containers/devbox/home/agent/ninfer-eval/pi-corpus /var/lib/local-llm/ninfer-eval/
```

## 1. Perplexity per KV format (redtruck, engine stopped)

`ninfer-perplexity` loads the model by itself, so the engine has to be off.
Each run defaults to a 65,536-token context with a 32,768-token stride.

```sh
sudo nixos-container root-login local-llm
systemctl stop ninfer

for kv in bf16 fp8 k8v4; do ninfer-ppl $kv; done
for kv in bf16 fp8 k8v4; do ninfer-ppl $kv --corpus /var/lib/ninfer-eval/pi-corpus/manifest.json; done

systemctl start ninfer
```

Reports land in `/var/lib/ninfer-eval/ppl/<time>-<kv>/report.json`, each with a
`.log` beside it. Compare runs over the same corpus, baseline first:

```sh
cd /var/lib/ninfer-eval/ppl
ninfer-ppl-compare <bf16 dir> <fp8 dir> <k8v4 dir>
```

The upstream corpus has four domains: English reference text, English long
form, Chinese, and `ninfer` (C++/CUDA code). The pi corpus has
`pi_orchestrator` and `pi_subagent`. Read the k8v4 change next to the fp8
change: fp8 is the loss you were already accepting. `--quick` scores one
stream per domain for a fast first look.

## 2. Greedy identity check (devbox, engine running)

Every config runs the same prompts at temperature 0, one at a time. Stop agent
traffic first: other requests batch with these and change the numerics.

Switch configs without a rebuild by writing one line on redtruck and restarting
the engine:

```sh
echo 'NINFER_EXTRA_ARGS=--kv-dtype fp8 --spec mtp --draft-tokens 3' | sudo tee /var/lib/local-llm/ninfer.env
sudo nixos-container run local-llm -- systemctl restart ninfer
```

| Label | `NINFER_EXTRA_ARGS` |
|---|---|
| `k8v4-dflash2` | (empty: the deployed config) |
| `k8v4-mtp3` | `--spec mtp --draft-tokens 3` |
| `fp8-dflash2` | `--kv-dtype fp8` |
| `fp8-mtp3` | `--kv-dtype fp8 --spec mtp --draft-tokens 3` (the config before #290) |

`--lm-head-draft` and `--cuda-graph-allowance-mib 512` stay on in every row,
as they were for MTP before #290. If an MTP row fails to start on the graph
allowance, add `--cuda-graph-allowance-mib 1024` to that line.

For each config, restart the engine, wait for `/ops/health`, then run the
check. Run the deployed config twice in a row: the second run is the noise
floor, and it also includes the effect of the warm prefix cache.

```sh
cd ~/ninfer-eval
nix run ~/projects/nixcfg#ninfer-greedy-check -- run --prompts pi-corpus/prompts.jsonl --label k8v4-dflash2
nix run ~/projects/nixcfg#ninfer-greedy-check -- run --prompts pi-corpus/prompts.jsonl --label k8v4-dflash2-again
# switch config, restart, then:
nix run ~/projects/nixcfg#ninfer-greedy-check -- run --prompts pi-corpus/prompts.jsonl --label k8v4-mtp3
# ... and so on for each row

nix run ~/projects/nixcfg#ninfer-greedy-check -- compare k8v4-dflash2.jsonl k8v4-dflash2-again.jsonl k8v4-mtp3.jsonl fp8-dflash2.jsonl fp8-mtp3.jsonl
```

How to read it:

- **dflash2 vs mtp3, same KV**: should match about as well as the repeat run.
  If they match clearly worse, one of them is not lossless.
- **fp8 vs k8v4, same spec**: shows how often the KV format changes the
  agent's next action. A different action is not necessarily a worse one; the
  perplexity runs say which way the change goes.

Remove the env line and restart when done:

```sh
sudo truncate -s0 /var/lib/local-llm/ninfer.env
sudo nixos-container run local-llm -- systemctl restart ninfer
```

## 3. BFCL multi-turn and IFBench (devbox, engine running)

`ninfer-eval-harness` runs NInfer's own eval harness (EvalScope) at the pinned
NInfer revision. The first run installs it into `~/.cache/ninfer-eval-venv`
(about 2.5 GB with CPU-only torch, kept on disk because `/tmp` is RAM). The
suite is `modules/local-llm/eval/agentic-suite.yaml`.

```sh
SUITE=~/projects/nixcfg/modules/local-llm/eval/agentic-suite.yaml
mkdir -p ~/ninfer-eval/harness && cd ~/ninfer-eval/harness
nix run ~/projects/nixcfg#ninfer-eval-harness -- run --config $SUITE --suite smoke
nix run ~/projects/nixcfg#ninfer-eval-harness -- run --config $SUITE --suite agentic
```

Run `agentic` once per engine config, switching configs the same way as in
section 2. Each run gets its own directory under `runs/`, and `summarize --run
<dir>` prints its scores. The full suite is 800 BFCL multi-turn samples plus
300 IFBench prompts, so it takes hours per config. Score differences of a few
points are within noise. IFBench samples at temperature 1.0, with about ±2.4
points of standard error. For reference, upstream reports IFBench at 77.0% for
this model with INT8 KV and MTP3.
