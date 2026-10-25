id: multiply
owns: calc.js, calc.test.js
reads: package.json
check: node --test
depends: none

Add an exported `multiply(a, b)` to calc.js returning a * b, and a `multiply` test in calc.test.js (for example multiply(4, 5) is 20 and multiply(-2, 3) is -6). Keep `add` unchanged.

Acceptance: `node --test` passes and includes the multiply test.
