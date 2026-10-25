import { test } from "node:test";
import assert from "node:assert/strict";
import { FIXTURE_TAG, add } from "./calc.js";

test("FIXTURE_TAG", () => {
  assert.equal(FIXTURE_TAG, "tinycalc-q7v2");
});

test("add", () => {
  assert.equal(add(2, 3), 5);
});
