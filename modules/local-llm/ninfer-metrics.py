"""Health and performance metrics for ninfer-serve, from its --request-log-jsonl.

  /health  /summary?window=15m|1h|6h|24h|all  /metrics  /requests?n=50
"""

import argparse
import collections
import http.server
import json
import os
import statistics
import threading
import time
import urllib.request

WINDOWS = {"15m": 900, "1h": 3600, "6h": 21600, "24h": 86400, "all": None}
RETAIN_REQUESTS = 50000
RETAIN_SAMPLES = 40000
GIB = 1024 ** 3


def pct(values, p):
    if not values:
        return None
    s = sorted(values)
    return s[min(len(s) - 1, int(p * len(s)))]


def num(x, default=0):
    return x if isinstance(x, (int, float)) else default


class LogTail:
    """Incrementally reads the request log, surviving truncation and restarts."""

    def __init__(self, path):
        self.path = path
        self.offset = 0
        self.inode = None
        self.requests = collections.deque(maxlen=RETAIN_REQUESTS)
        self.samples = collections.deque(maxlen=RETAIN_SAMPLES)
        self.server_start = None
        self.errors = 0
        self.last_event_ms = 0
        self.lock = threading.Lock()

    def poll(self):
        try:
            st = os.stat(self.path)
        except FileNotFoundError:
            return
        if self.inode != st.st_ino or st.st_size < self.offset:
            self.inode, self.offset = st.st_ino, 0
        if st.st_size == self.offset:
            return
        with open(self.path, "rb") as f:
            f.seek(self.offset)
            chunk = f.read()
        cut = chunk.rfind(b"\n")
        if cut < 0:
            return
        self.offset += cut + 1
        with self.lock:
            for line in chunk[:cut].split(b"\n"):
                if line:
                    self._ingest(line)

    def _ingest(self, line):
        try:
            ev = json.loads(line)
        except ValueError:
            self.errors += 1
            return
        kind = ev.get("event")
        ts = num(ev.get("timestamp_unix_ms"))
        self.last_event_ms = max(self.last_event_ms, ts)
        if kind == "request_done":
            self.requests.append(self._flatten_request(ev, ts))
        elif kind == "throughput":
            self.samples.append(self._flatten_sample(ev, ts))
        elif kind == "server_start":
            self.server_start = ev
            self.server_start_ts = ts
        elif kind == "request_error":
            self.errors += 1

    @staticmethod
    def _flatten_request(ev, ts):
        r, res, t = ev.get("request", {}), ev.get("result", {}), ev.get("timings_seconds", {})
        spec = ev.get("speculative") or {}
        prompt = num(res.get("prompt_tokens"))
        cached = num(res.get("prefix_cache_hit_tokens"))
        return {
            "ts": ts,
            "id": r.get("request_id"),
            "effort": r.get("requested_reasoning_effort") or "off",
            "tools": num(r.get("tool_count")),
            "messages": num(r.get("message_count")),
            "requested_output": num(r.get("requested_output_tokens")),
            "prompt": prompt,
            "cached": cached,
            "computed": num(res.get("computed_prefill_tokens")),
            "output": num(res.get("completion_tokens")),
            "finish": res.get("finish_reason", "?"),
            "path": res.get("prefix_reuse_path") or "none",
            "total": num(t.get("total")),
            "ttft": num(t.get("ttft")),
            "decode": num(t.get("decode")),
            "prefill": num(t.get("prefill")),
            "queue": num((ev.get("engine_timing") or {}).get("queue_wait_seconds")),
            "accepted": num(spec.get("accepted_tokens")),
            "drafted": num(spec.get("drafted_tokens")),
        }

    @staticmethod
    def _flatten_sample(ev, ts):
        cc = ev.get("context_cache") or {}
        occ = cc.get("occupancy") or {}
        pressure = cc.get("pressure") or {}
        kv = (cc.get("main_kv_transfers") or {}).get("h2d") or {}
        state = (cc.get("state_transfers") or {}).get("h2d") or {}
        sched = ev.get("scheduler") or {}
        tps = ev.get("throughput_tokens_per_second") or {}
        tok = ev.get("tokens") or {}
        return {
            "ts": ts,
            "interval": num(ev.get("interval_seconds"), 5),
            "prefill_tps": num(tps.get("prefill")),
            "decode_tps": num(tps.get("decode")),
            "prefill_tok": num(tok.get("computed_prefill")),
            "decode_tok": num(tok.get("committed_decode")),
            "batch": num((ev.get("decode_batch") or {}).get("average_size")),
            "running": num(sched.get("running")),
            "waiting": num(sched.get("waiting")),
            "host_kv_bytes": num(occ.get("host_kv_bytes")),
            "host_state_slots": num(occ.get("host_state_slots")),
            "device_state_slots": num(occ.get("device_state_slots")),
            "restores": num((cc.get("state_operations") or {}).get("restores")),
            "kv_h2d_bytes": num(kv.get("bytes")),
            "kv_h2d_seconds": num(kv.get("seconds")),
            "state_h2d_bytes": num(state.get("bytes")),
            "evicted": num(pressure.get("private_owners_evicted")) + num(pressure.get("shared_owners_evicted")),
        }

    def window(self, name):
        secs = WINDOWS[name]
        with self.lock:
            reqs, samples = list(self.requests), list(self.samples)
        if secs is None:
            return reqs, samples
        since = (time.time() - secs) * 1000
        return [r for r in reqs if r["ts"] >= since], [s for s in samples if s["ts"] >= since]

    def config(self):
        ev = self.server_start
        if not ev:
            return None
        eng, cc = ev.get("engine") or {}, (ev.get("engine") or {}).get("context_cache") or {}
        return {
            "instance": ev.get("server_instance_id"),
            "started_unix_ms": ev.get("timestamp_unix_ms"),
            "max_concurrency": eng.get("max_concurrency"),
            "max_context": eng.get("max_context"),
            "kv_capacity_tokens": eng.get("kv_capacity"),
            "host_kv_gib": round(num(cc.get("host_kv_capacity_bytes")) / GIB, 2),
            "host_state_slots": cc.get("host_state_slots"),
            "device_state_slots": cc.get("device_state_slots"),
            "max_private_continuations": cc.get("max_private_continuations"),
            "max_shared_prefixes": cc.get("max_shared_prefixes"),
            "speculative": eng.get("speculative_backend"),
            "draft_window": eng.get("speculative_draft_window"),
            "vision": eng.get("vision"),
            "argv": ev.get("argv"),
        }


def summarize(reqs, samples):
    n = len(reqs)
    prompt = sum(r["prompt"] for r in reqs)
    cached = sum(r["cached"] for r in reqs)
    computed = sum(r["computed"] for r in reqs)
    output = sum(r["output"] for r in reqs)
    drafted = sum(r["drafted"] for r in reqs)
    accepted = sum(r["accepted"] for r in reqs)
    decode_rates = [r["output"] / r["decode"] for r in reqs if r["decode"] > 0.05 and r["output"] >= 50]
    queue_s = sum(r["queue"] for r in reqs)
    prefill_s = sum(r["prefill"] for r in reqs)
    decode_s = sum(r["decode"] for r in reqs)
    mid = [r for r in reqs if r["messages"] > 4]
    cold = [r for r in mid if r["cached"] < 0.1 * r["prompt"]]
    finish = collections.Counter(r["finish"] for r in reqs)
    tiny_ceiling = sum(1 for r in reqs if r["finish"] == "output_limit" and r["requested_output"] <= 24)

    by_effort = {}
    for effort, group in _group(reqs, "effort").items():
        by_effort[effort] = {
            "requests": len(group),
            "mean_output": round(sum(r["output"] for r in group) / len(group)),
            "output_over_8k": sum(1 for r in group if r["output"] > 8000),
            "truncated": sum(1 for r in group if r["finish"] == "output_limit"),
            "gpu_minutes": round(sum(r["total"] for r in group) / 60, 1),
        }
    by_path = {}
    for path, group in _group(reqs, "path").items():
        d = sum(r["drafted"] for r in group)
        p = sum(r["prompt"] for r in group)
        by_path[path] = {
            "requests": len(group),
            "mtp_accept_pct": round(100 * sum(r["accepted"] for r in group) / d, 1) if d else None,
            "cached_pct": round(100 * sum(r["cached"] for r in group) / p, 1) if p else None,
        }

    conc = collections.Counter(s["running"] for s in samples)
    busy_prefill = [s["prefill_tps"] for s in samples if s["prefill_tps"] > 0]
    busy_decode = [s["decode_tps"] for s in samples if s["decode_tps"] > 0]
    decode_tok = sum(s["decode_tok"] for s in samples)
    h2d_bytes = sum(s["kv_h2d_bytes"] for s in samples)
    h2d_secs = sum(s["kv_h2d_seconds"] for s in samples)
    return {
        "requests": n,
        "span_hours": round((reqs[-1]["ts"] - reqs[0]["ts"]) / 3.6e6, 2) if n > 1 else 0,
        "tokens": {
            "prompt": prompt,
            "cached_pct": round(100 * cached / prompt, 1) if prompt else None,
            "re_prefilled": computed,
            "re_prefilled_pct": round(100 * computed / prompt, 1) if prompt else None,
            "output": output,
        },
        "time_budget_s": {
            "queue": round(queue_s),
            "prefill": round(prefill_s),
            "decode": round(decode_s),
            "queue_pct": round(100 * queue_s / (queue_s + prefill_s + decode_s), 1) if queue_s else 0.0,
        },
        "cache": {
            "mid_conversation": len(mid),
            "cold_under_10pct": len(cold),
            "cold_re_prefill_tokens": sum(r["computed"] for r in cold),
            "cold_re_prefill_seconds": round(sum(r["prefill"] for r in cold), 1),
        },
        "latency_s": {
            "ttft": _pcts([r["ttft"] for r in reqs]),
            "queue": _pcts([r["queue"] for r in reqs]),
            "total": _pcts([r["total"] for r in reqs]),
        },
        "decode_tok_s_per_request": _pcts(decode_rates),
        "mtp_accept_pct": round(100 * accepted / drafted, 1) if drafted else None,
        "finish": dict(finish),
        "truncated_with_ceiling_under_25": tiny_ceiling,
        "by_effort": by_effort,
        "by_reuse_path": by_path,
        "engine_samples": {
            "count": len(samples),
            "mean_prefill_tok_s_when_busy": round(statistics.fmean(busy_prefill)) if busy_prefill else None,
            "mean_decode_tok_s_when_busy": round(statistics.fmean(busy_decode)) if busy_decode else None,
            "decode_batch_token_weighted": round(
                sum(s["batch"] * s["decode_tok"] for s in samples) / decode_tok, 2
            )
            if decode_tok
            else None,
            "concurrency_pct": {str(k): round(100 * v / len(samples), 1) for k, v in sorted(conc.items())}
            if samples
            else {},
            "samples_with_queue_pct": round(100 * sum(1 for s in samples if s["waiting"] > 0) / len(samples), 1)
            if samples
            else None,
        },
        "ram_tier": {
            "restores": sum(s["restores"] for s in samples),
            "kv_h2d_gib": round(h2d_bytes / GIB, 2),
            "kv_h2d_seconds": round(h2d_secs, 2),
            "kv_h2d_gib_per_s": round(h2d_bytes / GIB / h2d_secs, 1) if h2d_secs else None,
            "peak_host_kv_gib": round(max((s["host_kv_bytes"] for s in samples), default=0) / GIB, 2),
            "peak_host_state_slots": max((s["host_state_slots"] for s in samples), default=0),
            "peak_device_state_slots": max((s["device_state_slots"] for s in samples), default=0),
            "evictions": sum(s["evicted"] for s in samples),
        },
    }


def _group(rows, key):
    out = collections.defaultdict(list)
    for r in rows:
        out[r[key]].append(r)
    return out


def _pcts(values):
    return {
        "p50": round(pct(values, 0.5), 3) if values else None,
        "p90": round(pct(values, 0.9), 3) if values else None,
        "p99": round(pct(values, 0.99), 3) if values else None,
        "max": round(max(values), 3) if values else None,
        "n": len(values),
    }


def prometheus(tail):
    reqs, samples = tail.window("all")
    lines = []

    def g(name, value, help_text, labels=""):
        if value is None:
            return
        lines.append(f"# HELP ninfer_{name} {help_text}")
        lines.append(f"# TYPE ninfer_{name} gauge")
        lines.append(f"ninfer_{name}{labels} {value}")

    cfg = tail.config() or {}
    g("up", 1 if tail.server_start else 0, "1 when a server_start has been seen in the log")
    g("config_max_concurrency", cfg.get("max_concurrency"), "--max-concurrency")
    g("config_host_kv_bytes", int(num(cfg.get("host_kv_gib")) * GIB), "--host-kv-mib as bytes")
    g("config_host_state_slots", cfg.get("host_state_slots"), "--host-state-slots")
    g("config_kv_capacity_tokens", cfg.get("kv_capacity_tokens"), "device KV pool in tokens")
    if samples:
        s = samples[-1]
        g("running", s["running"], "requests running at the last sample")
        g("waiting", s["waiting"], "requests queued at the last sample")
        g("host_kv_bytes", s["host_kv_bytes"], "host KV tier occupancy")
        g("host_state_slots_used", s["host_state_slots"], "host state slots occupied")
        g("device_state_slots_used", s["device_state_slots"], "device state slots occupied")
        g("prefill_tokens_per_second", round(s["prefill_tps"], 1), "prefill rate over the last sample")
        g("decode_tokens_per_second", round(s["decode_tps"], 1), "decode rate over the last sample")
        g("decode_batch_size", round(s["batch"], 2), "mean decode batch over the last sample")
    for finish, count in collections.Counter(r["finish"] for r in reqs).items():
        g("requests_total", count, "completed requests by finish reason", f'{{finish="{finish}"}}')
    g("prompt_tokens_total", sum(r["prompt"] for r in reqs), "prompt tokens received")
    g("cached_prompt_tokens_total", sum(r["cached"] for r in reqs), "prompt tokens served from prefix cache")
    g("computed_prefill_tokens_total", sum(r["computed"] for r in reqs), "prompt tokens actually prefilled")
    g("completion_tokens_total", sum(r["output"] for r in reqs), "output tokens generated")
    g("mtp_drafted_tokens_total", sum(r["drafted"] for r in reqs), "speculative tokens drafted")
    g("mtp_accepted_tokens_total", sum(r["accepted"] for r in reqs), "speculative tokens accepted")
    g("ram_restores_total", sum(s["restores"] for s in samples), "contexts restored from the host tier")
    g("ram_kv_h2d_bytes_total", sum(s["kv_h2d_bytes"] for s in samples), "KV bytes moved host to device")
    g("ram_kv_h2d_seconds_total", round(sum(s["kv_h2d_seconds"] for s in samples), 3), "time spent on those moves")
    g("evictions_total", sum(s["evicted"] for s in samples), "context owners evicted from the host tier")
    g("log_parse_errors_total", tail.errors, "log lines that did not parse, plus request_error events")
    g("log_last_event_age_seconds", round(time.time() - tail.last_event_ms / 1000, 1) if tail.last_event_ms else None,
      "seconds since the newest log event")
    return "\n".join(lines) + "\n"


class Handler(http.server.BaseHTTPRequestHandler):
    tail = None
    engine = None

    def log_message(self, *_):
        pass

    def do_GET(self):
        path, _, query = self.path.partition("?")
        params = dict(p.split("=", 1) for p in query.split("&") if "=" in p)
        try:
            if path == "/health":
                self._json(self._health())
            elif path == "/summary":
                window = params.get("window", "1h")
                if window not in WINDOWS:
                    return self._json({"error": f"window must be one of {list(WINDOWS)}"}, 400)
                reqs, samples = self.tail.window(window)
                body = {"window": window, "config": self.tail.config()}
                body.update(summarize(reqs, samples) if reqs else {"requests": 0})
                self._json(body)
            elif path == "/metrics":
                self._text(prometheus(self.tail), "text/plain; version=0.0.4")
            elif path == "/requests":
                n = max(1, min(int(params.get("n", "50")), 5000))
                reqs, _ = self.tail.window("all")
                self._json(reqs[-n:])
            elif path == "/":
                self._json({"endpoints": ["/health", "/summary?window=15m|1h|6h|24h|all", "/metrics", "/requests?n=50"]})
            else:
                self._json({"error": "not found"}, 404)
        except Exception as e:  # noqa: BLE001
            self._json({"error": str(e)}, 500)

    def _health(self):
        engine = {"url": self.engine, "ok": False}
        t0 = time.monotonic()
        try:
            with urllib.request.urlopen(self.engine + "/health", timeout=3) as resp:
                engine.update(ok=resp.status == 200, status=resp.status)
        except Exception as e:  # noqa: BLE001
            engine["error"] = str(e)
        engine["latency_ms"] = round((time.monotonic() - t0) * 1000, 1)
        tail = self.tail
        try:
            size = os.stat(tail.path).st_size
        except FileNotFoundError:
            size = None
        return {
            "engine": engine,
            "log": {
                "path": tail.path,
                "bytes": size,
                "last_event_age_s": round(time.time() - tail.last_event_ms / 1000, 1) if tail.last_event_ms else None,
                "requests_retained": len(tail.requests),
                "samples_retained": len(tail.samples),
                "parse_errors": tail.errors,
            },
            "config": tail.config(),
        }

    def _json(self, body, status=200):
        self._text(json.dumps(body, indent=1), "application/json", status)

    def _text(self, body, content_type, status=200):
        data = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--log", required=True, help="ninfer-serve --request-log-jsonl path")
    ap.add_argument("--engine", default="http://127.0.0.1:5800", help="engine base URL for /health")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=5801)
    ap.add_argument("--poll-seconds", type=float, default=2.0)
    args = ap.parse_args()

    tail = LogTail(args.log)
    tail.poll()

    def poll_forever():
        while True:
            time.sleep(args.poll_seconds)
            try:
                tail.poll()
            except Exception:  # noqa: BLE001
                tail.errors += 1

    threading.Thread(target=poll_forever, daemon=True).start()
    Handler.tail, Handler.engine = tail, args.engine.rstrip("/")
    server = http.server.ThreadingHTTPServer((args.host, args.port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
