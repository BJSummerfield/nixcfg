id: power
owns: power.js, power.test.js
reads: calc.js
check: node --test
depends: multiply

Create power.js exporting `power(base, exp)` for a non-negative integer exp, computed by repeated `multiply` imported from ./calc.js; power(x, 0) is 1. Throw a RangeError for a negative or non-integer exp. Add power.test.js covering power(2, 10) = 1024, power(5, 0) = 1 and the RangeError.

Acceptance: `node --test` passes and includes the power tests.
