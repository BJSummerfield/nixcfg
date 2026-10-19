"""Compare ninfer-eval-harness runs task by task.

  ninfer-bfcl-pair NAME RUN_DIR [NAME RUN_DIR ...]

The first run is the baseline. Every run must cover the same tasks. Prints
each run's score, then for each other run the tasks it lost and gained against
the baseline, with an exact McNemar p-value on those discordant tasks.
"""

import glob
import json
import math
import sys


def load(run):
    paths = glob.glob(f"{run}/backends/*/reviews/*/*.jsonl")
    if len(paths) != 1:
        sys.exit(f"{run}: expected one reviews file, found {len(paths)}")
    scores = {}
    with open(paths[0], encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            scores[r["index"]] = r["sample_score"]["score"]["value"]["acc"]
    return scores


def mcnemar(lost, gained):
    n = lost + gained
    if n == 0:
        return 1.0
    tail = sum(math.comb(n, i) for i in range(min(lost, gained) + 1))
    return min(1.0, 2 * tail / 2 ** n)


def main():
    args = sys.argv[1:]
    if len(args) < 4 or len(args) % 2:
        sys.exit(__doc__)
    names, runs = args[0::2], [load(p) for p in args[1::2]]
    for name, run in zip(names, runs):
        print(f"{name:<16} {sum(run.values()):>4}/{len(run)}  {sum(run.values()) / len(run):.1%}")
    base_name, base = names[0], runs[0]
    for name, run in zip(names[1:], runs[1:]):
        ids = sorted(set(base) & set(run))
        gained = sum(1 for i in ids if run[i] and not base[i])
        lost = sum(1 for i in ids if base[i] and not run[i])
        print(f"{name} vs {base_name}: {lost} lost, {gained} gained, net {gained - lost:+d}, "
              f"McNemar p={mcnemar(lost, gained):.2f}")


if __name__ == "__main__":
    main()
