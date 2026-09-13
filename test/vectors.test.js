// test/vectors.test.js
//
// The 106 cases from kyron-lenses, run against this repository's copy of the
// rules. They are the only thing keeping three implementations of one format
// honest: `Lens.tryParse` in the Kyron app, `problems()` in
// kyron-lenses/tools/lens.py, and src/format/lens.js here.
//
// A rule tightened in one and not the others means a lens passes the studio,
// gets published, and silently never appears on anybody's phone. This is what
// stops that.
//
// To refresh: npm run vectors:refresh (see docs/FORMAT_CONTRACT.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { problems } from '../src/format/lens.js';

const spec = JSON.parse(
  readFileSync(fileURLToPath(new URL('./format-vectors.json', import.meta.url)), 'utf8'),
);

test('the shared spec has cases to run', () => {
  assert.ok(Array.isArray(spec.cases), 'format-vectors.json has no cases');
  assert.ok(spec.cases.length >= 100, `only ${spec.cases.length} cases`);
});

for (const item of spec.cases) {
  test(`${item.accept ? 'accepts' : 'refuses'} ${item.id}`, () => {
    const found = problems(item.lens);
    const accepted = found.length === 0;
    assert.equal(
      accepted,
      item.accept,
      `${item.why}\n` +
        (found.length
          ? `      got: ${found.join('\n           ')}`
          : '      got: accepted with no complaint'),
    );
  });
}
