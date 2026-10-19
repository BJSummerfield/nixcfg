"""Greedy (temperature 0) outputs of one engine configuration, and how far two runs agree.

  run      send every prompt once, one at a time, and save the answers
  compare  line runs up against a baseline run, prompt by prompt

Speculative decoding verifies drafts against the target model, so at
temperature 0 it should reproduce the target's own greedy output. A KV format
change has no such guarantee; this measures how often it changes what the
agent does next.
"""

import argparse
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request


def post(url, body, timeout):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def wire_messages(messages):
    """OpenAI chat wants tool-call arguments as a JSON string; the corpus keeps them as objects."""
    out = []
    for m in messages:
        if m.get("tool_calls"):
            m = dict(m, tool_calls=[
                dict(c, function=dict(c["function"], arguments=c["function"]["arguments"]
                                      if isinstance(c["function"]["arguments"], str)
                                      else json.dumps(c["function"]["arguments"], ensure_ascii=False)))
                for c in m["tool_calls"]])
        out.append(m)
    return out


def cmd_run(args):
    if os.path.exists(args.out):
        sys.exit(f"{args.out} exists; pick a new name")
    with open(args.prompts, encoding="utf-8") as f:
        prompts = [json.loads(line) for line in f if line.strip()]
    url = args.base_url.rstrip("/") + "/chat/completions"
    with open(args.out, "w", encoding="utf-8") as out:
        for n, p in enumerate(prompts, 1):
            body = {
                "model": args.model,
                "messages": wire_messages(p["messages"]),
                "temperature": 0,
                "max_tokens": args.max_tokens,
                "chat_template_kwargs": {"enable_thinking": True, "reasoning_effort": args.effort or p.get("effort", "medium"), "preserve_thinking": True},
            }
            if p.get("tools"):
                body["tools"] = p["tools"]
            started = time.monotonic()
            try:
                resp = post(url, body, args.timeout)
                choice = resp["choices"][0]
                msg = choice.get("message") or {}
                row = {
                    "id": p["id"],
                    "reasoning": msg.get("reasoning_content") or msg.get("reasoning") or "",
                    "content": msg.get("content") or "",
                    "tool_calls": [{"name": c["function"]["name"], "arguments": c["function"].get("arguments", "")}
                                   for c in msg.get("tool_calls") or []],
                    "finish_reason": choice.get("finish_reason"),
                    "usage": resp.get("usage"),
                }
            except (urllib.error.URLError, KeyError, TimeoutError) as e:
                body_text = e.read().decode(errors="replace")[:300] if isinstance(e, urllib.error.HTTPError) else ""
                row = {"id": p["id"], "error": f"{e} {body_text}".strip()}
            row["seconds"] = round(time.monotonic() - started, 2)
            row["label"] = args.label
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
            out.flush()
            state = row.get("error") or f"{row['finish_reason']}, {len(row['tool_calls'])} tool calls"
            print(f"[{n}/{len(prompts)}] {row['seconds']:6.1f}s {p['id']}: {state}", file=sys.stderr)


def load(path):
    with open(path, encoding="utf-8") as f:
        return {r["id"]: r for r in map(json.loads, filter(str.strip, f)) if "error" not in r}


def stream_text(r):
    return r["reasoning"] + "\n</think>\n" + r["content"] + "\n" + json.dumps(r["tool_calls"], sort_keys=True)


def common_prefix(a, b):
    n = min(len(a), len(b))
    i = 0
    while i < n and a[i] == b[i]:
        i += 1
    return i


def compare_pair(base, other):
    ids = sorted(set(base) & set(other))
    exact, same_action, prefixes = 0, 0, []
    for i in ids:
        a, b = stream_text(base[i]), stream_text(other[i])
        exact += a == b
        same_action += base[i]["tool_calls"] == other[i]["tool_calls"] and base[i]["content"].strip() == other[i]["content"].strip()
        prefixes.append(common_prefix(a, b) / max(len(a), 1))
    return {
        "n": len(ids),
        "identical": exact / len(ids) if ids else None,
        "same_action": same_action / len(ids) if ids else None,
        "median_shared_prefix": statistics.median(prefixes) if prefixes else None,
        "min_shared_prefix": min(prefixes) if prefixes else None,
    }


def cmd_compare(args):
    runs = [(os.path.basename(p).removesuffix(".jsonl"), load(p)) for p in args.runs]
    (base_name, base), rest = runs[0], runs[1:]
    print(f"baseline: {base_name} ({len(base)} answers)\n")
    print(f"{'run':<28} {'n':>4} {'identical':>10} {'same action':>12} {'shared prefix p50':>18} {'min':>6}")
    for name, run in rest:
        s = compare_pair(base, run)
        if not s["n"]:
            print(f"{name:<28} no prompts in common")
            continue
        print(f"{name:<28} {s['n']:>4} {s['identical']:>10.0%} {s['same_action']:>12.0%} "
              f"{s['median_shared_prefix']:>18.0%} {s['min_shared_prefix']:>6.0%}")
    print("\nidentical: whole output equal. same action: same final text and tool calls (name + arguments).")
    print("shared prefix: share of the baseline output generated before the first difference.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser("run")
    run.add_argument("--prompts", required=True, help="prompts.jsonl from ninfer-pi-corpus")
    run.add_argument("--label", required=True, help="engine configuration name, e.g. k8v4-dflash2")
    run.add_argument("--out", help="defaults to <label>.jsonl")
    run.add_argument("--base-url", default="https://llm.mist-gamma.ts.net:8443/v1")
    run.add_argument("--model", default="Qwen3.8-27B-NVFP4")
    run.add_argument("--max-tokens", type=int, default=1024)
    run.add_argument("--effort", choices=["medium", "xhigh"], help="override the effort recorded with each prompt")
    run.add_argument("--timeout", type=float, default=900)
    cmp_ = sub.add_parser("compare")
    cmp_.add_argument("runs", nargs="+", help="baseline .jsonl first, then the runs to compare against it")
    args = ap.parse_args()
    if args.cmd == "run":
        args.out = args.out or f"{args.label}.jsonl"
        cmd_run(args)
    else:
        cmd_compare(args)


if __name__ == "__main__":
    main()
