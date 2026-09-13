// test/face.test.js
//
// The conversion between what an artist drags and what a lens is written in.
// Everything here is about the property that makes the format work: a lens
// authored on one face has to mean the same thing on another, at a different
// size, at a different angle.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FaceFrame, attachmentFor, placementFor, ANCHORS } from '../src/format/face.js';
import { attachmentProblems } from '../src/format/lens.js';

const ASSET = 'https://kyronlabs.github.io/kyron-lenses/assets/star.png';

/** An upright face with 100 pixels between the pupils, centred at 300,200. */
const upright = new FaceFrame({ x: 250, y: 200 }, { x: 350, y: 200 });

test('the gap is the unit and the midpoint is the origin', () => {
  assert.equal(upright.gap, 100);
  assert.equal(upright.roll, 0);
  assert.deepEqual(upright.origin, { x: 300, y: 200 });
});

test('a head at an angle has a roll, and the gap survives it', () => {
  // The same face, rolled 30 degrees about its own midpoint.
  const tilted = new FaceFrame(
    { x: 300 - 50 * Math.cos(Math.PI / 6), y: 200 - 50 * Math.sin(Math.PI / 6) },
    { x: 300 + 50 * Math.cos(Math.PI / 6), y: 200 + 50 * Math.sin(Math.PI / 6) },
  );
  assert.ok(Math.abs(tilted.gap - 100) < 1e-9, `gap moved to ${tilted.gap}`);
  assert.ok(Math.abs(tilted.roll - 30) < 1e-9, `roll was ${tilted.roll}`);
});

test('two pupils in the same place is refused, not treated as zero', () => {
  // Reachable from a tracker that lost the face mid-drag. A zero scale would
  // silently produce Infinity widths and a lens nobody could explain.
  assert.throws(() => new FaceFrame({ x: 5, y: 5 }, { x: 5, y: 5 }), RangeError);
});

test('a sticker 130px wide on a 100px face is 1.3 pupil-gaps', () => {
  const attachment = attachmentFor(
    upright,
    'eyes',
    { centre: { x: 300, y: 200 }, widthPx: 130 },
    ASSET,
  );
  assert.equal(attachment.width, 1.3);
  assert.equal(attachment.anchor, 'eyes');
  // Zeroes are left out rather than written down.
  assert.ok(!('offsetX' in attachment), 'a centred sticker carries no offsetX');
  assert.ok(!('rotation' in attachment), 'an unturned sticker carries no rotation');
});

test('and the numbers it produces are ones the app will accept', () => {
  const attachment = attachmentFor(
    upright,
    'forehead',
    { centre: { x: 320, y: 120 }, widthPx: 90, rotation: 12 },
    ASSET,
  );
  assert.deepEqual(attachmentProblems(attachment, 'attachment 0'), []);
});

test('an offset is measured from the anchor, not from the eyes', () => {
  // 'chin' sits 1.48 gaps below the pupil midpoint: 200 + 148 = 348.
  const onTheChin = attachmentFor(
    upright,
    'chin',
    { centre: { x: 300, y: 348 }, widthPx: 50 },
    ASSET,
  );
  assert.ok(!('offsetY' in onTheChin), 'a sticker on the chin is not offset from it');

  const belowIt = attachmentFor(
    upright,
    'chin',
    { centre: { x: 300, y: 398 }, widthPx: 50 },
    ASSET,
  );
  assert.equal(belowIt.offsetY, 0.5);
});

test('the same lens lands in the same place on a bigger face', () => {
  // The property the whole format rests on. Author on one face, render on
  // another twice the size: the attachment has to cover the same features.
  const small = new FaceFrame({ x: 250, y: 200 }, { x: 350, y: 200 });
  const large = new FaceFrame({ x: 100, y: 500 }, { x: 300, y: 500 });

  const attachment = attachmentFor(
    small,
    'mouth',
    { centre: { x: 320, y: 310 }, widthPx: 65, rotation: 8 },
    ASSET,
  );
  const landed = placementFor(large, attachment);

  // Twice the gap, so twice the width and twice the offset from the anchor.
  assert.ok(Math.abs(landed.widthPx - 130) < 1e-6, `width ${landed.widthPx}`);
  const anchor = large.anchorAt('mouth');
  assert.ok(Math.abs(landed.centre.x - (anchor.x + 40)) < 1e-6);
  assert.ok(Math.abs(landed.centre.y - (anchor.y + 30)) < 1e-6);
  assert.ok(Math.abs(landed.rotation - 8) < 1e-9);
});

test('a lens authored on a tilted head is upright on a level one', () => {
  // Offsets rotate with the head, which is what keeps a hat pushed "up" up
  // when somebody leans. Author against a 25-degree tilt, and the numbers
  // have to come out as though the head had been straight.
  const radians = (25 * Math.PI) / 180;
  const tilted = new FaceFrame(
    { x: 300 - 50 * Math.cos(radians), y: 200 - 50 * Math.sin(radians) },
    { x: 300 + 50 * Math.cos(radians), y: 200 + 50 * Math.sin(radians) },
  );

  // A sticker one gap straight above the pupils *in the head's own frame*.
  const centre = tilted.toPixels(0, -1, { from: 'eyes' });
  const attachment = attachmentFor(tilted, 'eyes', { centre, widthPx: 100 }, ASSET);

  assert.ok(Math.abs(attachment.offsetY - -1) < 1e-9, `offsetY ${attachment.offsetY}`);
  assert.ok(!('offsetX' in attachment), 'the tilt should not leak into offsetX');
  // Drawn on a level face it sits straight up, not at 25 degrees.
  assert.ok(Math.abs(attachment.rotation - -25) < 1e-9);
});

test('every anchor round-trips through pixels and back', () => {
  for (const anchor of ANCHORS) {
    const placement = { centre: { x: 337, y: 261 }, widthPx: 77, rotation: -14 };
    const attachment = attachmentFor(upright, anchor, placement, ASSET);
    const back = placementFor(upright, attachment);
    assert.ok(Math.abs(back.centre.x - placement.centre.x) < 1e-3, anchor);
    assert.ok(Math.abs(back.centre.y - placement.centre.y) < 1e-3, anchor);
    assert.ok(Math.abs(back.widthPx - placement.widthPx) < 1e-3, anchor);
    assert.ok(Math.abs(back.rotation - placement.rotation) < 1e-9, anchor);
  }
});

test('an absurd drag is reported, not quietly clamped', () => {
  // 4000px wide on a 100px face is 40 pupil-gaps. Clamping it to the legal 12
  // would publish a lens nobody drew; the format check is what says no.
  const huge = attachmentFor(
    upright,
    'eyes',
    { centre: { x: 300, y: 200 }, widthPx: 4000 },
    ASSET,
  );
  assert.equal(huge.width, 40);
  const found = attachmentProblems(huge, 'attachment 0');
  assert.equal(found.length, 1);
  assert.match(found[0], /width 40 must be above 0 and at most 12/);
});
