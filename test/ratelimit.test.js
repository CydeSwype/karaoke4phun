import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter } from '../server/ratelimit.js';

test('allows up to max hits per window, per key', () => {
  const lim = createLimiter({ windowMs: 1000, max: 2 });
  assert.equal(lim.hit('a', 0), true);
  assert.equal(lim.hit('a', 10), true);
  assert.equal(lim.hit('a', 20), false);
  assert.equal(lim.hit('b', 20), true); // other clients are unaffected
});

test('hits expire once the window has passed', () => {
  const lim = createLimiter({ windowMs: 1000, max: 1 });
  assert.equal(lim.hit('a', 0), true);
  assert.equal(lim.hit('a', 500), false);
  assert.equal(lim.hit('a', 1000), true);
});
