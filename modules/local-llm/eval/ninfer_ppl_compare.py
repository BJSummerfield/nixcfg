"""Compare ninfer-perplexity reports: perplexity per domain and the change against the first report.

Pass report directories (or report.json files); the first is the baseline.
Only reports over the same corpus, context and stride are comparable.
"""

import argparse
import json
import math
import os
import sys


def load(path):
    if os.path.isdir(path):
        path = os.path.join(path, "report.json")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def protocol(report):
    ex = report["execution"]
    return (report["corpus"]["id"], report["corpus"]["mode"], ex["context_tokens"], ex["stride_tokens"])


def rows(report):
    out = {d["domain"]: d for d in report["domains"]}
    out["overall"] = report["overall"]
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("reports", nargs="+")
    args = ap.parse_args()
    reports = [load(p) for p in args.reports]

    protocols = {protocol(r) for r in reports}
    if len(protocols) > 1:
        sys.exit(f"reports use different corpus/context/stride and are not comparable: {sorted(protocols)}")
    corpus, mode, context, stride = protocols.pop()
    print(f"corpus {corpus} ({mode}), context {context}, stride {stride}\n")

    base = rows(reports[0])
    names = [r["execution"]["kv_dtype"] for r in reports]
    domains = [d for d in base if d != "overall"] + ["overall"]
    head = f"{'domain':<20} {'tokens':>9}" + "".join(f" {n:>10}" for n in names)
    head += "".join(f" {'Δ ' + n:>10}" for n in names[1:])
    print(head)
    for d in domains:
        values = [rows(r).get(d) for r in reports]
        line = f"{d:<20} {base[d]['scored_tokens']:>9}"
        line += "".join(f" {v['perplexity']:>10.4f}" if v else f" {'-':>10}" for v in values)
        for v in values[1:]:
            line += f" {math.exp(v['mean_nll'] - base[d]['mean_nll']) - 1:>+10.2%}" if v else f" {'-':>10}"
        print(line)
    print(f"\nΔ is the perplexity change against {names[0]}; it equals exp(Δ mean NLL) - 1.")


if __name__ == "__main__":
    main()
