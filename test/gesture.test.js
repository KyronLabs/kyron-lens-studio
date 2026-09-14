import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MIN_WIDTH,
  handlePositions,
  normalise,
  rotationFromDrag,
  widthFromDrag,
} from '../src/app/gesture.js';
import { FaceFrame, attachmentFor, placementFor } from '../src/format/face.js';
import { attachmentProblems } from '../src/format/lens.js';

/** A plane-local point at `degrees` from the local +x axis, `r` out. */
const at = (degrees, r = 1) => ({
  x: r * Math.cos((degrees * Math.PI) / 180),
  y: r * Math.sin((degrees * Math.PI) / 180),
});

describe('dragging a corner', () => {
  it('scales about the centre, not about the corner', () => {
    // A corner of a 4 x 2 plane is at (2, 1). Twice as far out is twice
    // as wide -- and the centre has not moved, which is the point: the
    // attachment grows around its anchor rather than away from the grab.
    const width = widthFromDrag({
      grab: { x: 2, y: 1 },
      at: { x: 4, y: 2 },
      width: 4,
    });
    assert.equal(width, 8);
  });

  it('shrinks by the same rule', () => {
    assert.equal(
      widthFromDrag({ grab: { x: 2, y: 1 }, at: { x: 1, y: 0.5 }, width: 4 }),
      2,
    );
  });

  it('measures distance, so sliding along the diagonal does nothing', () => {
    const width = widthFromDrag({
      grab: { x: 3, y: 4 },
      at: { x: -3, y: -4 },
      width: 1,
    });
    assert.equal(width, 1);
  });

  it('will not drag an attachment down to nothing', () => {
    // Not the design clamp attachmentFor deliberately refuses. A plane with
    // no width draws nothing and cannot be grabbed again, so dragging the
    // handle through the centre would lose the attachment with no way back.
    const width = widthFromDrag({
      grab: { x: 2, y: 0 },
      at: { x: 0, y: 0 },
      width: 4,
    });
    assert.equal(width, MIN_WIDTH);
    assert.ok(width > 0);
  });

  it('keeps the width when there is nothing to measure', () => {
    // A ray parallel to the plane -- the head turned edge-on mid-drag --
    // hits nothing, and a NaN here would be written straight into the lens.
    assert.equal(
      widthFromDrag({ grab: { x: 1, y: 0 }, at: { x: NaN, y: NaN }, width: 3 }),
      3,
    );
    assert.equal(
      widthFromDrag({ grab: { x: 0, y: 0 }, at: { x: 5, y: 5 }, width: 3 }),
      3,
    );
  });

  it('produces a width the format will accept', () => {
    const width = widthFromDrag({
      grab: { x: 1, y: 0 },
      at: { x: 1.4, y: 0 },
      width: 2,
    });
    const problems = attachmentProblems(
      { asset: 'https://kyron.so/a.png', anchor: 'eyes', width },
      'attachment',
    );
    assert.deepEqual(problems, []);
  });
});

describe('dragging the rotate handle', () => {
  it('turns the way the cursor went', () => {
    // The handle starts straight up. Dragged to the right, that is a
    // clockwise quarter turn on screen, and the format counts clockwise as
    // positive -- so this is the sign the whole file is about.
    assert.equal(
      rotationFromDrag({ grab: at(90), at: at(0), rotation: 0 }),
      90,
    );
    assert.equal(
      rotationFromDrag({ grab: at(90), at: at(180), rotation: 0 }),
      -90,
    );
  });

  it('adds to the rotation already there', () => {
    assert.equal(
      rotationFromDrag({ grab: at(90), at: at(60), rotation: 20 }),
      50,
    );
  });

  it('ignores how far out the cursor is', () => {
    assert.equal(
      rotationFromDrag({ grab: at(90, 0.2), at: at(45, 9), rotation: 0 }),
      45,
    );
  });

  it('stays in one turn', () => {
    // 350 and -10 are the same picture and the format takes both. Keeping
    // one means a diff after a rotate says what actually changed.
    // A clockwise nudge from 179 lands on 189, which is -171 the short way.
    assert.equal(
      rotationFromDrag({ grab: at(90), at: at(80), rotation: 179 }),
      -171,
    );
    // And the same nudge anti-clockwise needs no wrapping at all.
    assert.equal(
      rotationFromDrag({ grab: at(90), at: at(100), rotation: 179 }),
      169,
    );
    assert.equal(normalise(360), 0);
    assert.equal(normalise(-180), 180);
    assert.equal(normalise(180), 180);
    assert.equal(normalise(540), 180);
    assert.ok(!Object.is(normalise(-360), -0));
  });

  it('keeps the rotation when there is nothing to measure', () => {
    for (const bad of [{ x: 0, y: 0 }, { x: NaN, y: NaN }]) {
      assert.equal(rotationFromDrag({ grab: at(90), at: bad, rotation: 12 }), 12);
      assert.equal(rotationFromDrag({ grab: bad, at: at(0), rotation: 12 }), 12);
    }
  });

  it('produces a rotation the format will accept', () => {
    let rotation = 0;
    // Six clockwise quarter turns -- one and a half revolutions.
    for (let turn = 0; turn < 6; turn++) {
      rotation = rotationFromDrag({ grab: at(90), at: at(0), rotation });
    }
    assert.ok(Math.abs(rotation) <= 360);
    assert.deepEqual(
      attachmentProblems(
        { asset: 'https://kyron.so/a.png', anchor: 'eyes', width: 1, rotation },
        'attachment',
      ),
      [],
    );
  });
});

describe('where the handles go', () => {
  it('puts one on each corner and one clear of the top edge', () => {
    const { resize, rotate } = handlePositions(4, 2, 0.5);
    assert.deepEqual(resize.map((it) => it.name), ['nw', 'ne', 'se', 'sw']);
    assert.deepEqual(resize[0], { name: 'nw', x: -2, y: 1 });
    assert.deepEqual(resize[2], { name: 'se', x: 2, y: -1 });
    // Outside the artwork, because on an attachment small enough that the
    // corners already crowd each other there is nowhere inside to put it.
    assert.deepEqual(rotate, { x: 0, y: 1.5 });
    assert.ok(rotate.y > 2 / 2);
  });
});

describe('a resize survives the round trip through the format', () => {
  it('lands where it was dragged, on a face of any size', () => {
    // The property the format rests on, extended to a drag: resize on one
    // face, publish, and place on a face twice the size and rolled over.
    const small = new FaceFrame({ x: 100, y: 200 }, { x: 160, y: 200 });
    const placement = { centre: { x: 130, y: 140 }, widthPx: 90, rotation: 0 };
    const attachment = attachmentFor(small, 'forehead', placement, 'https://k/a.png');

    const grown = widthFromDrag({
      grab: { x: 45, y: 0 },
      at: { x: 90, y: 0 },
      width: attachment.width,
    });
    const resized = { ...attachment, width: grown };
    assert.ok(Math.abs(resized.width - attachment.width * 2) < 1e-9);

    // Twice the gap exactly, and rolled 25 degrees, which is the case the
    // format's own property test uses.
    const roll = (25 * Math.PI) / 180;
    const big = new FaceFrame(
      { x: 400, y: 500 },
      { x: 400 + 120 * Math.cos(roll), y: 500 + 120 * Math.sin(roll) },
    );
    const back = placementFor(big, resized);
    // Twice the width in gaps, on a face with twice the gap: four times the
    // pixels, and still the same feature under it.
    assert.ok(Math.abs(back.widthPx - placement.widthPx * 4) < 1e-6);
    assert.deepEqual(attachmentProblems(resized, 'attachment'), []);
  });
});
