# Plan: tinycalc multiply and power

## Problem
tinycalc only adds. It needs multiplication, and an integer power built on multiplication.

## Approach
Add `multiply` to calc.js with a test, then add `power` in a new module that uses `multiply`.

## Tasks, in merge order
1. multiply: add `multiply(a, b)` to calc.js and test it.
2. power: add power.js exporting `power(base, exp)` for non-negative integer exp using `multiply`, with power.test.js.

## Final checks
none

## Changes avoided
No dependencies, no build step.

## Open risks
None.
