// The instructions (prompt.ts): the caveman rules are in every run's, not
// left to the skill being opened.

import { test } from "node:test";
import assert from "node:assert/strict";
import { brainInstructions } from "../src/prompt.js";

test("every run's instructions carry the caveman rules, without the skill's front matter", () => {
  const text = brainInstructions();
  assert.match(text, /## How every answer is written \(caveman, always on, every message\)/);
  assert.match(text, /The answer first, then stop\./);
  assert.match(text, /#### The rule/);
  assert.doesNotMatch(text, /^name: caveman$/m);
});
