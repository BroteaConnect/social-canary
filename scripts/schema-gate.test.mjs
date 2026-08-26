// GENERATED FILE by `brotea quality sync` (quality/schema-gate.test.mjs in the
// factory). Do not edit it here: change the catalog and re-sync, or the next
// fleet migration will stomp on your changes.
//
// The data model this app declares, checked by the app's own CI with no
// credentials and no factory. What it can prove is that the DECLARATION is
// sound; whether an instance matches it is the nightly audit's job, and that
// audit can only hold an instance to something the repository actually says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { findings } from './schema-gate.mjs';

const read = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

test('the declared data model is sound', () => {
  const lock = read('brotea.json');
  // A missing lockfile is not a pass. Every app the factory composes has one,
  // and a check that quietly succeeds when it cannot find its input is
  // indistinguishable from a check that ran.
  assert.ok(lock, 'no brotea.json — this gate cannot say anything about an app it cannot identify');
  const problems = findings(lock, read('pb/schema.json'));
  assert.deepEqual(problems, [], `\n  ✖ ${problems.join('\n  ✖ ')}\n`);
});
