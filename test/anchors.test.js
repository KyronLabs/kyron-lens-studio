// test/anchors.test.js
//
// ANCHOR_OFFSETS is derived data. This is what keeps it derived.
//
// Four numbers in a source file are indistinguishable from four numbers
// somebody remembered, and the first version of that table was exactly that:
// every row wrong, the chin by 0.43 pupil-gaps. Re-deriving it from the mesh
// on every test run is the difference between a constant and a claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ANCHOR_OFFSETS, ANCHORS } from '../src/format/face.js';
import { deriveAnchors, readVertices, LANDMARKS } from '../tools/derive-anchors.mjs';

test('the mesh is the canonical one, not something that got edited', () => {
  const vertices = readVertices();
  assert.equal(vertices.length, 468);

  // The centre-line landmarks are on the centre line.
  for (const name of ['noseTip', 'chin', 'forehead', 'lipTop', 'lipBottom']) {
    assert.equal(vertices[LANDMARKS[name]].x, 0, `${name} is off centre`);
  }

  // And the face is symmetric about it: each left landmark mirrors its right.
  // A stronger check than "the nose is furthest forward", which is not even
  // true -- vertex 4, the columella, is 0.11 in front of landmark 1.
  for (const [left, right] of [
    [LANDMARKS.leftEyeOuter, LANDMARKS.rightEyeOuter],
    [LANDMARKS.leftEyeInner, LANDMARKS.rightEyeInner],
  ]) {
    assert.equal(vertices[left].x, -vertices[right].x, 'the eyes are not mirrored');
    assert.equal(vertices[left].y, vertices[right].y);
    assert.equal(vertices[left].z, vertices[right].z);
  }
});

test('every anchor in the table matches the mesh it claims to come from', () => {
  const derived = deriveAnchors();
  for (const anchor of ANCHORS) {
    assert.deepEqual(
      ANCHOR_OFFSETS[anchor],
      derived[anchor],
      `${anchor} has drifted from the canonical mesh — run ` +
        'node tools/derive-anchors.mjs and paste the table in',
    );
  }
});

test('the table covers every anchor the format allows, and no more', () => {
  assert.deepEqual(Object.keys(ANCHOR_OFFSETS).sort(), [...ANCHORS].sort());
});

test('the face is the right way up', () => {
  // Positive y is down. Getting this backwards flips every lens through the
  // eye line, which looks almost plausible on a symmetrical sticker.
  assert.ok(ANCHOR_OFFSETS.forehead.y < 0, 'the forehead is above the eyes');
  assert.ok(ANCHOR_OFFSETS.nose.y > 0, 'the nose is below the eyes');
  assert.ok(ANCHOR_OFFSETS.chin.y > ANCHOR_OFFSETS.mouth.y, 'the chin is lowest');
  assert.ok(ANCHOR_OFFSETS.mouth.y > ANCHOR_OFFSETS.nose.y);
});
