#!/usr/bin/env python3
import argparse
import concurrent.futures as cf
import json
import math
import os
import random
import sys
import threading
import time
import urllib.request

MODEL = "Qwen3.8-27B-NVFP4"
GAUGES = ("running", "waiting", "paused", "preemptions_total", "snapshot_restores_total",
          "replay_restores_total", "replayed_tokens_total", "host_context_bytes",
          "ram_restores_total", "ram_kv_h2d_bytes_total", "spill_pages_total")
COUNTERS = GAUGES[3:7] + GAUGES[8:]
GIB = 2 ** 30


def http(url, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data, {"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode()


def read_metrics(base):
    out = dict.fromkeys(GAUGES, 0.0)
    for line in http(base + "/ops/metrics", timeout=5).splitlines():
        if line.startswith("ninfer_"):
            name, _, val = line.rpartition(" ")
            name = name.split("{")[0][len("ninfer_"):]
            if name in GAUGES:
                out[name] = out.get(name, 0.0) + float(val)
    return out


def make_vocab():
    rng = random.Random(20261010)
    cons, vows = "bdfgklmnprstvz", "aeiou"
    words = set()
    while len(words) < 4096:
        words.add("".join(rng.choice(cons) + rng.choice(vows) for _ in range(rng.choice((2, 3, 3, 4)))))
    return sorted(words)


VOCAB = make_vocab()


class Monitor:
    def __init__(self, base):
        self.base, self.samples, self.stop, self.t0 = base, [], threading.Event(), time.time()
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        while not self.stop.is_set():
            try:
                self.samples.append({"t": round(time.time() - self.t0, 1), **read_metrics(self.base)})
            except Exception:
                pass
            self.stop.wait(1)

    def timeline(self, start):
        prev, lines = None, []
        for s in self.samples[start:]:
            cur = tuple(s.get(k) for k in GAUGES)
            if cur != prev:
                lines.append("  t=%6.1f " % s["t"] + " ".join("%s=%g" % (k.replace("_total", ""), s.get(k, 0)) for k in GAUGES))
                prev = cur
        return lines

    def peaks(self, start):
        ss = self.samples[start:]
        return {k: max([s.get(k, 0) for s in ss] or [0]) for k in ("running", "waiting", "paused")}


class Ctx:
    def __init__(self, a):
        self.a, self.base = a, a.base_url.rstrip("/")
        self.tpw, self.max_ctx, self.pool = a.tokens_per_word, a.max_context, a.kv_capacity
        self.run_id = a.seed if a.seed is not None else int.from_bytes(os.urandom(6), "big")
        self.mon = Monitor(self.base)

    def text(self, rng, tokens):
        return " ".join(rng.choice(VOCAB) for _ in range(max(1, int(tokens / self.tpw))))

    def rng(self, tag):
        return random.Random("%s/%s" % (self.run_id, tag))

    def first_prompt(self, tag, tokens, instr):
        rng = self.rng(tag)
        head = "Document %s-%s-%.12f.\n" % (self.run_id, tag, rng.random())
        return head + self.text(rng, tokens - 40) + "\n" + instr

    def chat(self, label, messages, max_tokens):
        r = {"label": label, "ok": False, "t0": time.time()}
        try:
            body = {"model": MODEL, "messages": messages, "max_tokens": max_tokens,
                    "chat_template_kwargs": {"enable_thinking": False}}
            d = json.loads(http(self.base + "/v1/chat/completions", body, timeout=1800))
            u = d["usage"]
            r.update(ok=True, id=d.get("id"), prompt=u["prompt_tokens"], out=u.get("completion_tokens"),
                     cached=(u.get("prompt_tokens_details") or {}).get("cached_tokens") or 0,
                     content=d["choices"][0]["message"]["content"] or "")
        except Exception as e:
            r["err"] = str(e)[:160]
        r["t1"] = time.time()
        return r

    def cold(self, label, tokens, max_tokens, instr="Reply with the single word ok."):
        return self.chat(label, [{"role": "user", "content": self.first_prompt(label, tokens, instr)}], max_tokens)

    def attach(self, results, since):
        try:
            d = json.loads(http(self.base + "/ops/requests?n=400"))
            recs = d if isinstance(d, list) else d.get("requests", [])
        except Exception:
            return
        recs = [x for x in recs if x.get("ts", 0) >= (since - 5) * 1000]
        used = set()
        for r in results:
            if not r["ok"]:
                continue
            c = [x for x in recs if id(x) not in used and (x.get("id") == r["id"] or x.get("prompt") == r["prompt"])]
            c.sort(key=lambda x: (x.get("id") != r["id"], min(abs(x.get("ts", 0) / 1000 - r["t0"]), abs(x.get("ts", 0) / 1000 - r["t1"]))))
            if c:
                used.add(id(c[0]))
                r["rec"] = c[0]

    def wait_idle(self, timeout=300):
        end = time.time() + timeout
        while time.time() < end:
            try:
                m = read_metrics(self.base)
                if m.get("running", 0) == 0 and m.get("waiting", 0) == 0 and m.get("paused", 0) == 0:
                    return True
            except Exception:
                pass
            time.sleep(2)
        print("  warning: engine not idle after %ds, continuing" % timeout)
        return False


def delta(a, b):
    return {k: b.get(k, 0) - a.get(k, 0) for k in COUNTERS}


def rec(r, k, d="-"):
    v = (r.get("rec") or {}).get(k)
    return d if v is None else v


def fmt_row(r):
    if not r["ok"]:
        return "  %-10s ERROR %s" % (r["label"], r.get("err"))

    def f(v):
        return "%.1f" % v if isinstance(v, (int, float)) else str(v)

    return "  %-10s prompt=%-6s cached=%-6s path=%-10s queue=%s ttft=%s total=%s preempt=%s paused=%s replayed=%s wall=%.0fs" % (
        r["label"], r["prompt"], r["cached"], rec(r, "path"), f(rec(r, "queue")), f(rec(r, "ttft")), f(rec(r, "total")),
        rec(r, "preemptions"), f(rec(r, "paused")), rec(r, "replayed"), r["t1"] - r["t0"])


def run_test(ctx, name, fn):
    print("\n== %s ==" % name)
    ctx.wait_idle()
    start, t0, m0 = len(ctx.mon.samples), time.time(), read_metrics(ctx.base)
    status, summary, results, extra = fn(ctx, m0)
    m1 = read_metrics(ctx.base)
    ctx.attach(results, t0)
    for r in results:
        print(fmt_row(r))
    d = delta(m0, m1)
    print("  deltas:", " ".join("%s=%g" % (k.replace("_total", ""), v) for k, v in d.items()),
          "peaks:", ctx.mon.peaks(start), "host_bytes %.2f -> %.2f GiB" % (m0.get("host_context_bytes", 0) / GIB, m1.get("host_context_bytes", 0) / GIB))
    print("  timeline (changes only):")
    print("\n".join(ctx.mon.timeline(start)))
    print("%s %s: %s" % (status, name, summary))
    slim = [{k: v for k, v in r.items() if k != "content"} for r in results]
    return {"name": name, "status": status, "summary": summary, "deltas": d, "results": slim, "extra": extra}


def host_bytes(ctx):
    return read_metrics(ctx.base).get("host_context_bytes", 0)


def ensure_host_full(ctx):
    a = ctx.a
    need = a.host_threshold * a.host_capacity_gib * GIB
    results, flat = [], 0
    try:
        cur = host_bytes(ctx)
    except Exception as e:
        return "SKIP", "metrics endpoint unreachable: %s" % e, results
    n = 0
    while cur < need:
        if n >= a.fill_max:
            return "FAIL", "host %.2f GiB still < %.0f%% of %.2f GiB after %d fills" % (cur / GIB, a.host_threshold * 100, a.host_capacity_gib, n), results
        n += 1
        r = ctx.cold("fill%d" % n, a.fill_tokens, 8)
        results.append(r)
        if not r["ok"]:
            return "FAIL", "fill request failed: %s" % r["err"], results
        time.sleep(2)
        new = host_bytes(ctx)
        flat = flat + 1 if new - cur < a.stall_bytes else 0
        print("  fill %d/%d: host=%.2f/%.2f GiB%s" % (n, a.fill_max, new / GIB, a.host_capacity_gib, " (no growth)" if flat else ""))
        cur = new
        if flat >= a.stall_fills:
            return "FAIL", "host occupancy stalled at %.2f GiB (< %.0f%% of %.2f GiB) for %d consecutive fills; Host tier is refusing writes (likely #378)" % (
                cur / GIB, a.host_threshold * 100, a.host_capacity_gib, flat), results
    return "OK", "host %.2f GiB >= %.0f%% of capacity after %d fills" % (cur / GIB, a.host_threshold * 100, n), results


def test_pause(ctx, m0):
    a = ctx.a
    st, msg, fills = ensure_host_full(ctx)
    if st != "OK":
        return st, "Host precondition: " + msg, fills, {}
    m0 = read_metrics(ctx.base)
    if m0["host_context_bytes"] < a.host_threshold * a.host_capacity_gib * GIB:
        return "FAIL", "refusing to judge: Host tier below %.0f%% at pause start" % (a.host_threshold * 100), fills, {}
    per = int(a.pause_frac * ctx.max_ctx) - a.pause_max_tokens
    instr = "Ignore the text above. Count from 1 to 200, one number per line, nothing else."
    with cf.ThreadPoolExecutor(a.pause_n) as ex:
        futs = []
        for i in range(a.pause_n):
            futs.append(ex.submit(ctx.cold, "pause%d" % i, per, a.pause_max_tokens, instr))
            time.sleep(0.3)
        results = [f.result() for f in futs]
    time.sleep(2)
    d = delta(m0, read_metrics(ctx.base))
    ctx.attach(results, results[0]["t0"])
    replayed = d["replayed_tokens_total"] + sum(rec(r, "replayed", 0) for r in results if r["ok"])
    if d["snapshot_restores_total"] > 0 and replayed == 0:
        mode = "snapshot"
    elif replayed > 0 and d["snapshot_restores_total"] > 0:
        mode = "mixed"
    elif replayed > 0 or d["replay_restores_total"] > 0:
        mode = "replay"
    else:
        mode = "none"
    errs = [r for r in results if not r["ok"]]
    ok = not errs and d["preemptions_total"] >= 1 and not (a.expect_snapshot and mode != "snapshot")
    why = "%d/%d completed, preemptions=%g, resume=%s" % (len(results) - len(errs), len(results), d["preemptions_total"], mode)
    return ("PASS" if ok else "FAIL"), why, fills + results, {"resume_mode": mode, "host_full": msg}


def test_growth(ctx, m0):
    a = ctx.a
    rows, lock = [], threading.Lock()

    def convo(name):
        rng = ctx.rng("grow" + name)
        msgs = [{"role": "user", "content": ctx.first_prompt("grow" + name, a.growth_start, "Ignore the text above. Count from 1 to 300, one number per line, nothing else.")}]
        for turn in range(1, a.growth_turns + 1):
            r = ctx.chat("%s%d" % (name, turn), msgs, a.growth_max_tokens)
            r["conv"], r["turn"] = name, turn
            with lock:
                rows.append(r)
            if not r["ok"]:
                return
            msgs += [{"role": "assistant", "content": r["content"]},
                     {"role": "user", "content": "More text for turn %d:\n%s\nIgnore it. Count from 1 to 300 again, one number per line." % (turn + 1, ctx.text(rng, a.growth_step))}]
            time.sleep(a.growth_gap)

    ts = []
    for n in "ABCDEFGH"[:a.growth_convs]:
        ts.append(threading.Thread(target=convo, args=(n,)))
        ts[-1].start()
        time.sleep(0.5)
    for t in ts:
        t.join()
    rows.sort(key=lambda r: (r["conv"], r["turn"]))
    bad = []
    for r in rows:
        if not r["ok"]:
            bad.append("%s error" % r["label"])
        elif r["turn"] > 1:
            prev = next((p for p in rows if p["conv"] == r["conv"] and p["turn"] == r["turn"] - 1), None)
            if prev and prev["ok"] and r["cached"] < prev["prompt"] - a.tolerance:
                bad.append("%s cached %d < prev prompt %d" % (r["label"], r["cached"], prev["prompt"]))
    short = [c for c in "ABCDEFGH"[:a.growth_convs] if sum(1 for r in rows if r["conv"] == c) < a.growth_turns]
    bad += ["%s incomplete" % c for c in short]
    return ("FAIL" if bad else "PASS"), ("; ".join(bad[:6]) if bad else "%d turns, every follow-up reused its prior prompt" % len(rows)), rows, {}


def test_host(ctx, m0):
    a = ctx.a
    st, msg, results = ensure_host_full(ctx)
    if st != "OK":
        return st, "Host precondition: " + msg, results, {}
    time.sleep(2)
    mA = read_metrics(ctx.base)
    instr = "Ignore the text above. Reply with the single word ok."
    msgs = [{"role": "user", "content": ctx.first_prompt("target", a.target_tokens, instr)}]
    t1 = ctx.chat("target1", msgs, 16)
    results.append(t1)
    if not t1["ok"]:
        return "FAIL", "target turn 1 failed", results, {}
    time.sleep(2)
    mB = read_metrics(ctx.base)
    per = int(0.9 * ctx.max_ctx) - 16
    k = math.ceil(a.evict_factor * ctx.pool / per)
    print("  evicting with %d concurrent cold requests of ~%d tokens" % (k, per))
    with cf.ThreadPoolExecutor(k) as ex:
        futs = []
        for i in range(k):
            futs.append(ex.submit(ctx.cold, "evict%d" % i, per, 16))
            time.sleep(0.3)
        ev = [f.result() for f in futs]
    results += ev
    ctx.wait_idle(180)
    time.sleep(2)
    mC = read_metrics(ctx.base)
    evict_tokens = sum(e["prompt"] for e in ev if e["ok"])
    spill = mC["spill_pages_total"] - mB["spill_pages_total"]
    moved = mC["host_context_bytes"] - mB["host_context_bytes"]
    extra = {"host_gib": {"before_fill_done": mA["host_context_bytes"] / GIB, "after_turn1": mB["host_context_bytes"] / GIB, "after_evict": mC["host_context_bytes"] / GIB},
             "evictor_tokens": evict_tokens, "pool": ctx.pool, "spill_pages_delta": spill, "host_bytes_delta_evict": moved}
    print("  eviction evidence: evictor tokens=%d vs pool=%d, spill_pages +%g, host bytes %+d" % (evict_tokens, ctx.pool, spill, moved))
    if any(not e["ok"] for e in ev):
        return "FAIL", "evictor errors", results, extra
    if evict_tokens <= ctx.pool or (spill <= 0 and moved == 0):
        return "FAIL", "inconclusive (failing closed): no evidence target left the GPU (evictor tokens=%d, pool=%d, spill_pages +%g, host bytes %+d)" % (evict_tokens, ctx.pool, spill, moved), results, extra
    msgs += [{"role": "assistant", "content": t1["content"]},
             {"role": "user", "content": "More text:\n%s\nIgnore it. Reply with the single word ok." % ctx.text(ctx.rng("target2"), 500)}]
    mD = read_metrics(ctx.base)
    t2 = ctx.chat("target2", msgs, 16)
    results.append(t2)
    time.sleep(2)
    mE = read_metrics(ctx.base)
    restores = mE["ram_restores_total"] - mD["ram_restores_total"]
    h2d = mE["ram_kv_h2d_bytes_total"] - mD["ram_kv_h2d_bytes_total"]
    ctx.attach([t1, t2], t1["t0"])
    extra.update(host_gib_after_turn2=mE["host_context_bytes"] / GIB, ram_restores_delta=restores, ram_h2d_bytes_delta=h2d,
                 target_paths=[rec(t1, "path"), rec(t2, "path")])
    print("  turn2: ram_restores +%g, h2d bytes +%d, paths %s, host %.2f GiB" % (restores, h2d, extra["target_paths"], mE["host_context_bytes"] / GIB))
    if not t2["ok"]:
        return "FAIL", "target turn 2 failed: %s" % t2["err"], results, extra
    if "rec" not in t2:
        return "FAIL", "turn 2 has no matching /ops/requests record (failing closed)", results, extra
    ok = t2["cached"] >= t1["prompt"] - a.tolerance and rec(t2, "path") != "root" and restores > 0
    why = "turn2 cached=%d of turn1 prompt=%d, path=%s, ram_restores +%g, h2d +%.2f GiB" % (t2["cached"], t1["prompt"], rec(t2, "path"), restores, h2d / GIB)
    return ("PASS" if ok else "FAIL"), why + ("" if ok else " (not served via Host restore; Host tier did not take the new conversation)"), results, extra


def plan(a, ctx):
    per = int(a.pause_frac * ctx.max_ctx) - a.pause_max_tokens
    last = a.growth_start + (a.growth_turns - 1) * a.growth_step * ctx.tpw
    ek = math.ceil(a.evict_factor * ctx.pool / (int(0.9 * ctx.max_ctx) - 16))
    print("PLAN (dry run, no requests sent) max_context=%d pool=%d tokens/word=%.3f" % (ctx.max_ctx, ctx.pool, ctx.tpw))
    print("pause: first fills Host tier to %.0f%% (stall of %d fills = FAIL); then %d concurrent cold requests x ~%d tokens (total %d vs pool %d), max_tokens=%d, expect_snapshot=%s"
          % (a.host_threshold * 100, a.stall_fills, a.pause_n, per, a.pause_n * per, ctx.pool, a.pause_max_tokens, a.expect_snapshot))
    print("growth: %d conversations, %d tokens start, +~%d words/turn, %d turns, gap %gs, max_tokens=%d; final prompt ~%d (+%d out) vs max_context %d"
          % (a.growth_convs, a.growth_start, a.growth_step, a.growth_turns, a.growth_gap, a.growth_max_tokens, last, a.growth_max_tokens, ctx.max_ctx))
    print("host-admit: need host_context_bytes >= %.0f%% of %.2f GiB, else up to %d sequential fills of ~%d tokens; "
          "stall of %d fills = FAIL; then target ~%d tokens, %d evictors of ~%d tokens (needs sum > pool and spill/host change), then target turn 2 "
          "must have a /ops/requests record, cached within %d, and ram_restores delta > 0"
          % (a.host_threshold * 100, a.host_capacity_gib, a.fill_max, a.fill_tokens, a.stall_fills, a.target_tokens, ek, int(0.9 * ctx.max_ctx) - 16, a.tolerance))


def main():
    p = argparse.ArgumentParser(description="Live cache/preemption/host-tier checks for NInfer")
    p.add_argument("--base-url", default="https://llm.mist-gamma.ts.net:8443")
    p.add_argument("--test", choices=("pause", "growth", "host-admit", "all"), default="all")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--json-out")
    p.add_argument("--seed", type=int, help="fixes prefixes; reuse shares cache with the prior run")
    p.add_argument("--tolerance", type=int, default=512, help="cached-token slack for reuse checks")
    p.add_argument("--tokens-per-word", type=float, default=1.589, help="dry-run value; calibrated live otherwise")
    p.add_argument("--max-context", type=int, default=102400)
    p.add_argument("--kv-capacity", type=int, default=233792)
    p.add_argument("--pause-n", type=int, default=3)
    p.add_argument("--pause-frac", type=float, default=0.94)
    p.add_argument("--pause-max-tokens", type=int, default=300)
    p.add_argument("--expect-snapshot", action="store_true")
    p.add_argument("--growth-convs", type=int, default=3)
    p.add_argument("--growth-start", type=int, default=40000)
    p.add_argument("--growth-step", type=int, default=6300, help="words added per turn (~10k tokens)")
    p.add_argument("--growth-turns", type=int, default=6)
    p.add_argument("--growth-gap", type=float, default=5)
    p.add_argument("--growth-max-tokens", type=int, default=1500)
    p.add_argument("--host-capacity-gib", type=float, default=17.09)
    p.add_argument("--host-threshold", type=float, default=0.9)
    p.add_argument("--fill-tokens", type=int, default=60000)
    p.add_argument("--fill-max", type=int, default=40)
    p.add_argument("--stall-fills", type=int, default=3, help="consecutive fills without Host growth that count as a refusal")
    p.add_argument("--stall-bytes", type=int, default=64 * 1024 * 1024)
    p.add_argument("--target-tokens", type=int, default=30000)
    p.add_argument("--evict-factor", type=float, default=1.25, help="evictor tokens as a multiple of the KV pool")
    a = p.parse_args()
    ctx = Ctx(a)
    tests = {"pause": test_pause, "growth": test_growth, "host-admit": test_host}
    names = list(tests) if a.test == "all" else [a.test]
    if a.dry_run:
        plan(a, ctx)
        return 0
    h = json.loads(http(ctx.base + "/ops/health")).get("config", {})
    ctx.pool = h.get("kv_capacity_tokens", ctx.pool)
    ctx.max_ctx = h.get("max_context", ctx.max_ctx)
    cal = ctx.chat("calibrate", [{"role": "user", "content": "x " + " ".join(VOCAB[:1500])}], 1)
    if not cal["ok"]:
        sys.exit("calibration failed: " + cal["err"])
    ctx.tpw = (cal["prompt"] - 15) / 1500
    print("pool=%d max_context=%d tokens/word=%.3f run_id=%s" % (ctx.pool, ctx.max_ctx, ctx.tpw, ctx.run_id))
    ctx.mon.thread.start()
    outs = []
    try:
        for n in names:
            outs.append(run_test(ctx, n, tests[n]))
    finally:
        ctx.mon.stop.set()
    print()
    for o in outs:
        print("%s %s: %s" % (o["status"], o["name"], o["summary"]))
    if a.json_out:
        json.dump({"pool": ctx.pool, "max_context": ctx.max_ctx, "tokens_per_word": ctx.tpw, "tests": outs, "samples": ctx.mon.samples}, open(a.json_out, "w"), indent=1)
    sts = {o["status"] for o in outs}
    return 1 if "FAIL" in sts else 2 if "SKIP" in sts else 0


if __name__ == "__main__":
    sys.exit(main())
