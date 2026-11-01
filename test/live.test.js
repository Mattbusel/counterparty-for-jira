// Live tests against the real public sources. Run: npm run test:live
// These prove the engine works on today's data, so they assert on facts that are stable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenCounterparty } from '../src/core/screen.js';

const live = process.env.LIVE === '1';

test('OFAC: a listed Russian bank entity is blocked', { skip: !live, timeout: 120000 }, async () => {
  const r = await screenCounterparty('Sberbank Capital', { fetch });
  assert.equal(r.verdict, 'BLOCK');
  assert.match(r.sources[0].findings[0].title, /SBERBANK CAPITAL/);
});

test('HHS-OIG: an excluded home health agency is blocked', { skip: !live, timeout: 120000 }, async () => {
  const r = await screenCounterparty('1 Best Care, Inc.', { fetch });
  assert.equal(r.verdict, 'BLOCK');
  assert.equal(r.sources.find(s => s.source === 'leie').severity, 'block');
});

test('Joins: a large U.S. public company resolves in GLEIF, SEC and USAspending', { skip: !live, timeout: 120000 }, async () => {
  const r = await screenCounterparty('Palantir Technologies Inc.', { fetch });
  assert.equal(r.identity.lei, '549300UVN46B3BBDHO85');
  assert.match(r.sources.find(s => s.source === 'sec').findings[0].title, /CIK 1321655/);
  assert.equal(r.sources.find(s => s.source === 'ofac').severity, 'none');
  assert.notEqual(r.sources.find(s => s.source === 'usaspending').findings.length, 0);
});
