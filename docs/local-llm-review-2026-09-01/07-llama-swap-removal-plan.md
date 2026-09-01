# Plan: removing llama-swap

Supersedes the "keep it" verdict in [`03-llama-swap.md`](03-llama-swap.md). That
conclusion rested on llama-swap being the only route to vLLM's metrics — which was true,
but only because llama-swap assigns the vLLM port dynamically. The argument was circular.

## Why

llama-swap does not swap anything here: one model in `enabled`, `ttl = null` so it is
never unloaded, and no aliases since PR #148. What it does do is stand between us and the
engine, and most of the awkwardness in `modules/local-llm/` traces back to it.

The decisive item is not tidiness. It is this, from the module's own comments:

```
:17   # podman socket grants root-equivalent host access
:123  "...grants the container root-equivalent access to the host"
:189  "root-equivalent on the host; fine for a single-user box,
       don't reuse this pattern on a shared machine"
```

`/run/podman/podman.sock` is bind-mounted into the nspawn container for exactly one
consumer: llama-swap, driving host podman over the API. Remove llama-swap and the grant
goes with it — the pattern the author warned about stops existing.

## The network question, answered

The tailnet name `llm.mist-gamma.ts.net` belongs to the **tailscale node inside the
local-llm container**, not to llama-swap. llama-swap is merely what `tailscale serve
--https=8443` currently points at. So the fix is to point it one hop earlier.

```
before:  devbox/workbox ──tailnet──► llm.mist-gamma.ts.net:8443
                                       └─ tailscale serve ──► 127.0.0.1:8081 (llama-swap)
                                                                └─ 192.168.100.24:${PORT} (vLLM)
         Open WebUI ──► http://127.0.0.1:8081/v1

after:   devbox/workbox ──tailnet──► llm.mist-gamma.ts.net:8443
                                       └─ tailscale serve ──► 192.168.100.24:5800 (vLLM)
         Open WebUI ──► http://192.168.100.24:5800/v1
```

**devbox and workbox change nothing** — same URL, same `baseUrl` in `models.nix`, same pi
config. The container remains the tailnet front door; it just stops running a proxy in
front of the proxying `tailscale serve` was already doing.

The container→host path already exists and is already permitted. The
`networking.firewall.interfaces."ve-local-llm"` range 5800–5999 is precisely that
traversal — llama-swap uses it today from `.25` to `.24`. It collapses to a single port
because the port stops being dynamic.

## Design decisions

### Fixed port 5800
The first port llama-swap's `${PORT}` macro assigns, so nothing else on the box has
claimed it, and the firewall change is a range→single collapse rather than a new hole.

### A plain systemd unit, not `virtualisation.oci-containers`
`oci-containers` is the idiomatic NixOS wrapper and would generate the unit for us, but it
pulls the image as part of starting the container. That directly contradicts a decision
already made and reasoned about here:

> Type=exec so neither boot nor nixos-rebuild switch blocks on the download; it continues
> in the background. A model started mid-download fails fast until the image lands.

Keeping `--pull=never` plus the separate `vllm-image-pull` unit preserves that. A
hand-written unit is a few more lines and keeps the existing design intact rather than
steamrolling it.

### `vllmArgs` survives; only the YAML scaffolding dies
Worth being accurate about the size of this: `llama-swap.nix` is 114 lines, but the
catalog→flags mapping in `vllmArgs` is still needed and moves rather than disappears.
What actually goes is the YAML generation, `proxy:`, `cmd:`/`cmdStop:`, `healthCheckTimeout`,
`logLevel`, the `${PORT}` macro and the alias/`useModelName` block — roughly half the file.
Suggested home: `modules/local-llm/vllm-service.nix`, taking the catalog and returning the
systemd unit.

### Aliases become `--served-model-name a b c`
vLLM accepts multiple served names, so alias support survives removal and gets *more*
honest: today llama-swap rewrites an alias back via `useModelName`, so vLLM never sees it.
Served natively, an alias id is a name vLLM actually answers to.

Nothing in `enabled` has an alias today (PR #148 deleted the only one), so this is latent —
but it keeps the catalog shape intact for the parked 3.6 entry. Note the existing
name-charset assertion gets load-bearing here, since the flag is space-separated.

### `ttl` leaves the catalog schema
It is a llama-swap concept — when to unload an idle model. With a systemd unit the engine
is simply always up. Delete the field from the schema and from every entry rather than
leaving a knob that does nothing.

### Readiness: `ExecStartPost` polling `/health`
llama-swap's `healthCheckTimeout: 900` *holds* a client request through a cold start. A
systemd unit cannot do that, and this is a genuine behavioural regression (see "What we
lose"). What it can do is not report the unit as started until vLLM actually serves, so
`systemctl start vllm` is meaningful and other units can order after it. Poll `/health`
with a matching 900 s ceiling.

## The diff, by file

| File | Change |
| --- | --- |
| `llama-swap.nix` | deleted; `vllmArgs` moves to `vllm-service.nix` |
| `container.nix` | drop `systemd.services.llama-swap`, `environment.etc."llama-swap.yaml"`, `pkgs.podman` from `systemPackages`; repoint `OPENAI_API_BASE_URL` to `http://192.168.100.24:5800/v1`; drop 8081 from the container firewall; rewrite the header comment's `tailscale serve` line |
| `nixos.nix` | new `systemd.services.vllm`; drop the `/run/podman/podman.sock` bind mount, `podmanSock`/`podmanCli`, `systemd.sockets.podman`; host `allowedTCPPorts` and NAT `forwardPorts` lose 8081; `ve-local-llm` range 5800–5999 → single 5800; simplify the metrics scrape (no `/running` guard, no `/upstream` path); revise the `cuda.enable` option description, which currently promises root-equivalent access it will no longer grant |
| `models.nix` | drop `ttl` from every entry and from the schema comment |
| `03-llama-swap.md` | mark superseded, state why the argument failed |

### Also worth checking, not asserting
The nspawn container is granted the NVIDIA devices and `/run/opengl-driver`, gated on
`nvidiaEnabled` rather than `cudaEnabled`. With vLLM on the host, nothing in the container
uses the GPU — llama-swap does not, Open WebUI does not. This looks like residue from the
GGUF era (the `healthCheckTimeout` comment still says "not the ~15s a GGUF mmap was"). Very
likely deletable, but verify Open WebUI does not pull something in before dropping it.
**Not part of this PR** unless the check is quick and clean — it is a separate concern from
removing the proxy.

## Manual steps (not declarative)

`tailscale serve` state lives on the node, not in nix. The header comment in
`container.nix` documents the current invocation; it must be re-run once after the switch:

```bash
sudo nixos-container root-login local-llm
tailscale serve --bg --https=8443 http://192.168.100.24:5800   # was: 8081
```

This is also the rollback gotcha: reverting the nix change alone leaves `serve` pointed at
a port nothing listens on. Revert both.

## Verification

1. **The engine is up and is the unit's child**
   `systemctl status vllm` → active; `podman ps` shows the container.
2. **Direct metrics, no proxy** — the whole point:
   `curl -s http://192.168.100.24:5800/metrics | grep -c '^vllm:'`
3. **`/v1/models` stops lying.** Today it reports `max_model_len: null`, `owned_by:
   llama-swap`. It should now report the real ceiling:
   `curl -s http://192.168.100.24:5800/v1/models | jq '.data[]'`
4. **Logs land in the journal natively**, with no `--log-driver` pin:
   `journalctl -u vllm | grep -i 'GPU KV cache size'`
5. **The tailnet path still works, unchanged from the client's side** — this is the one
   that matters, run it *from devbox*:
   `curl -s https://llm.mist-gamma.ts.net:8443/v1/models`
6. **Open WebUI still lists the model** in its UI.
7. **The socket grant is gone:**
   `ls /var/lib/nixos-containers/local-llm/run/podman/` → absent.
8. **A real pi turn completes** from devbox and from workbox.

## What we lose

1. **`/api/metrics/activity`** — the per-request token+duration log, and the dashboard over
   it. This does not move; it is llama-swap's own construct. vLLM's `/metrics` is aggregate
   histograms with no per-request join. Mitigation: the `request_queue_time_seconds`
   histogram is a *better* verification for the concurrency change anyway (baseline: 90.2%
   < 0.3 s, 4.4% > 20 s, 1.3% > 60 s, tail 480 s), and pi's session logs still carry
   per-turn tokens and timestamps for a coarser reconstruction.
2. **Cold-start request holding.** Clients get connection-refused for the minutes vLLM
   takes to load, instead of a held request. With the engine always up this bites on boot
   or a deliberate restart only, and both pi and Open WebUI retry.
3. **The `/logs` and activity web UI.** Confirmed not a standing workflow — it was being
   used to gather data for this review, and querying redtruck directly replaces that.

## Sequencing

Recommended **after** the concurrency PR, not before. Two reasons: the concurrency change
is the one with measured user-visible value (queue waits to 480 s), and doing it while
`/api/metrics/activity` still exists means the concurrency-vs-latency curve is available as
verification alongside the histogram. Removal is cleanup — do it once the tuning has
settled, so it deletes plumbing you have stopped needing rather than an instrument you are
mid-experiment on.

Doing it first also works; it just means verifying the concurrency change on histograms
alone, which is sufficient.

Note this PR deletes two things added in #149 — the `--log-driver=journald` pin and the
`/running` guard on the scrape. Both exist only to work around llama-swap. That is
deliberate: #149 buys measurement today at the cost of ~20 throwaway lines.

## What this does not change

`virtualisation.podman.enable` and `hardware.nvidia-container-toolkit.enable` stay — vLLM
is still a podman container, still on the host, still using the NVIDIA CDI device. The
`vllm-image-pull` unit stays and is unaffected; it already runs `podman pull` on the host
directly, which is the proof the host-side pattern works. The nspawn container stays, with
tailscale and Open WebUI. `models.nix` keeps every tuning knob. pi's config is untouched.
