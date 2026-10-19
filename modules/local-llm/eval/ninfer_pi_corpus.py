"""Turn pi session logs into a ninfer-perplexity corpus and a greedy-check prompt set.

Each stream is one contiguous model context (a session, split at compactions),
rendered with the model's own chat template, so perplexity is scored on the
text the engine actually saw: system prompt, tool schemas, thinking, tool
calls and tool results.
"""

import argparse
import json
import os
import random
import sys

import jinja2


def tojson(value, indent=None):
    return json.dumps(value, ensure_ascii=False, indent=indent)


def raise_exception(message):
    raise jinja2.TemplateError(message)


def load_template(path):
    env = jinja2.Environment(trim_blocks=True, lstrip_blocks=True, extensions=["jinja2.ext.loopcontrols"])
    env.filters["tojson"] = tojson
    env.globals["raise_exception"] = raise_exception
    with open(path, encoding="utf-8") as f:
        return env.from_string(f.read())


def text_of(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text")


def system_text(message):
    content = message.get("content") or ""
    sections = message.get("sections")
    if not content and isinstance(sections, dict):
        content = "\n\n".join(v for v in sections.values() if isinstance(v, str) and v.strip())
    return content


def tools_of(message):
    tools = []
    for t in message.get("toolsAdded") or []:
        if isinstance(t, dict) and t.get("name"):
            tools.append({"type": "function", "function": {
                "name": t["name"],
                "description": t.get("description", ""),
                "parameters": t.get("parameters", {"type": "object", "properties": {}}),
            }})
    return tools


def convert(entry):
    """Map one pi message entry to an OpenAI chat message, or None to skip it."""
    m = entry.get("message") or {}
    role = m.get("role")
    if role == "user":
        text = text_of(m.get("content"))
        return {"role": "user", "content": text} if text.strip() else None
    if role == "toolResult":
        return {"role": "tool", "tool_call_id": m.get("toolCallId", ""), "content": text_of(m.get("content"))}
    if role == "assistant":
        parts = m.get("content") or []
        out = {
            "role": "assistant",
            "content": "\n".join(p.get("text", "") for p in parts if p.get("type") == "text"),
            "reasoning_content": "\n".join(p.get("thinking", "") for p in parts if p.get("type") == "thinking"),
        }
        calls = [p for p in parts if p.get("type") == "toolCall"]
        if calls:
            out["tool_calls"] = [{
                "id": c.get("id", ""),
                "type": "function",
                "function": {"name": c.get("name", ""), "arguments": c.get("arguments") or {}},
            } for c in calls]
        return out
    return None


def effort_of(level):
    return "xhigh" if level in ("high", "xhigh", "max") else "medium"


def segments(path, model_filter):
    """Yield (effort, system, tools, messages) for each contiguous context in one session file."""
    model = None
    effort, system, tools, messages = "medium", "", [], []
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind = entry.get("type")
            if kind == "model_change" and model is None:
                model = entry.get("modelId", "")
                if model_filter not in model:
                    return
            elif kind == "thinking_level_change":
                effort = effort_of(entry.get("thinkingLevel"))
            elif kind == "compaction":
                if messages:
                    yield effort, system, tools, messages
                messages = []
                summary = entry.get("summary")
                if isinstance(summary, str) and summary.strip():
                    messages.append({"role": "user", "content": summary})
            elif kind == "message":
                m = entry.get("message") or {}
                if m.get("role") == "system":
                    system = system_text(m) or system
                    tools = tools_of(m) or tools
                    continue
                converted = convert(entry)
                if converted is not None:
                    messages.append(converted)
    if model is not None and messages:
        yield effort, system, tools, messages


def as_chat(system, messages):
    head = [{"role": "system", "content": system}] if system else []
    msgs = head + messages
    while msgs and msgs[-1]["role"] == "system":
        msgs.pop()
    return msgs


def render(template, effort, system, tools, messages, **extra):
    return template.render(messages=as_chat(system, messages), tools=tools or None, enable_thinking=True,
                           reasoning_effort=effort, preserve_thinking=True, **extra)


def has_user_query(messages):
    return any(m["role"] == "user" for m in messages)


def session_files(root):
    """Top-level sessions are orchestrators; run-*/session.jsonl below them are sub-agents."""
    found = {"pi_orchestrator": [], "pi_subagent": []}
    for d, _, names in os.walk(root):
        for n in names:
            if n.endswith(".jsonl"):
                domain = "pi_subagent" if n == "session.jsonl" else "pi_orchestrator"
                found[domain].append(os.path.join(d, n))
    for paths in found.values():
        paths.sort(key=os.path.getmtime, reverse=True)
    return found


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--sessions", default=os.path.expanduser("~/.pi/agent/sessions"))
    ap.add_argument("--template", required=True, help="the model's chat_template.jinja")
    ap.add_argument("--out", required=True, help="new or empty output directory")
    ap.add_argument("--model", default="Qwen3.8", help="keep sessions whose first model id contains this")
    ap.add_argument("--min-kib", type=int, default=200, help="drop rendered contexts smaller than this (~4 bytes/token)")
    ap.add_argument("--max-mib", type=float, default=4.0, help="total corpus size, split evenly between the two domains")
    ap.add_argument("--prompts", type=int, default=40, help="greedy-check prompts to sample")
    ap.add_argument("--prompt-max-kib", type=int, default=120, help="largest rendered prompt to sample")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    if os.path.exists(args.out) and os.listdir(args.out):
        sys.exit(f"{args.out} exists and is not empty")
    os.makedirs(os.path.join(args.out, "data"), exist_ok=True)
    template = load_template(args.template)
    rng = random.Random(args.seed)
    budget = args.max_mib * 1024 * 1024 / 2

    streams, candidates = [], {}
    for domain, files in session_files(args.sessions).items():
        total = 0
        for path in files:
            if total >= budget:
                break
            for i, (effort, system, tools, messages) in enumerate(segments(path, args.model)):
                if total >= budget or not has_user_query(messages):
                    continue
                try:
                    text = render(template, effort, system, tools, messages)
                except jinja2.TemplateError as e:
                    print(f"skip {path} #{i}: {e}", file=sys.stderr)
                    continue
                size = len(text.encode("utf-8"))
                if size < args.min_kib * 1024 or "\0" in text:
                    continue
                sid = f"{domain}-{sum(s['domain'] == domain for s in streams):03d}"
                with open(os.path.join(args.out, "data", sid + ".txt"), "w", encoding="utf-8") as f:
                    f.write(text)
                streams.append({"id": sid, "domain": domain, "path": f"data/{sid}.txt",
                                "source": f"{os.path.relpath(path, args.sessions)}#{i}"})
                total += size
                candidates[sid] = [(effort, system, tools, messages[:j]) for j, m in enumerate(messages)
                                   if m["role"] == "assistant" and has_user_query(messages[:j])]

    if not streams:
        sys.exit("no session matched; check --sessions, --model and --min-kib")

    by_domain = {d: [s["id"] for s in streams if s["domain"] == d] for d in ("pi_orchestrator", "pi_subagent")}
    quick = by_domain["pi_orchestrator"][:2] + by_domain["pi_subagent"][:2]
    manifest = {"corpus_id": "pi-agent-transcripts", "streams": streams,
                "modes": {"quick": quick, "full": [s["id"] for s in streams]}}
    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    for pool in candidates.values():
        rng.shuffle(pool)
    prompts = []
    while len(prompts) < args.prompts and any(candidates.values()):
        for sid, pool in candidates.items():
            while pool and len(prompts) < args.prompts:
                effort, system, tools, prefix = pool.pop()
                rendered = render(template, effort, system, tools, prefix, add_generation_prompt=True)
                if len(rendered.encode("utf-8")) <= args.prompt_max_kib * 1024:
                    prompts.append({"id": f"{sid}@{len(prefix)}", "effort": effort,
                                    "messages": as_chat(system, prefix), "tools": tools})
                    break
    with open(os.path.join(args.out, "prompts.jsonl"), "w", encoding="utf-8") as f:
        for p in prompts:
            f.write(json.dumps(p, ensure_ascii=False) + "\n")

    sizes = {d: sum(os.path.getsize(os.path.join(args.out, s["path"])) for s in streams if s["domain"] == d)
             for d in by_domain}
    for d, ids in by_domain.items():
        print(f"{d}: {len(ids)} streams, {sizes[d] / 1024 / 1024:.1f} MiB")
    print(f"{len(prompts)} prompts -> {args.out}")


if __name__ == "__main__":
    main()
