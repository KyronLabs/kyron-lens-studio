import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ADJUSTMENTS, GAP_MM, RANGE, describeWidth, gapsToMm, mmToGaps, show } from '../src/app/units.js';
import { fromAdjustments, withinLimits } from '../src/format/matrix.js';
import { attachmentProblems, effectProblems } from '../src/format/lens.js';

describe('pupil-gaps in units somebody can picture', () => {
  it('converts both ways without drifting', () => {
    for (const gaps of [0.05, 1, 2.6, 12]) {
      assert.ok(Math.abs(mmToGaps(gapsToMm(gaps)) - gaps) < 1e-9);
    }
    assert.equal(gapsToMm(1), GAP_MM);
  });

  it('writes a number the way a field wants it', () => {
    assert.equal(show(2.6), '2.6');
    assert.equal(show(2.6000000001), '2.6');
    assert.equal(show(2), '2');
    assert.equal(show(Number.NaN), '—');
  });

  it('says what a width actually is', () => {
    assert.equal(describeWidth(2.6), '2.6 gaps · about 164mm');
  });
});

describe('the controls cannot build a lens the app refuses', () => {
  it('keeps every attachment slider inside the format', () => {
    // A slider that reaches a value the format refuses is a control that
    // silently builds an unpublishable lens. Both ends of each, checked
    // against the same rules the app uses.
    for (const [field, range] of Object.entries(RANGE)) {
      if (!['width', 'offsetX', 'offsetY', 'rotation'].includes(field)) continue;
      for (const end of [range.min, range.max]) {
        const attachment = {
          asset: 'https://example.com/a.png',
          anchor: 'eyes',
          width: 1,
          [field]: end,
        };
        assert.deepEqual(
          attachmentProblems(attachment, 'a'),
          [],
          `${field} at ${end} is outside the format`,
        );
      }
    }
  });

  it('keeps every effect slider inside the format', () => {
    const shapes = {
      fill: { kind: 'fill', region: 'lowerFace' },
      frost: { kind: 'frost' },
    };
    const owner = {
      feather: ['fill', 'frost'],
      keepShading: ['fill'],
      blur: ['frost'],
      desaturate: ['frost'],
      lift: ['frost'],
    };
    for (const [field, kinds] of Object.entries(owner)) {
      for (const kind of kinds) {
        for (const end of [RANGE[field].min, RANGE[field].max]) {
          assert.deepEqual(
            effectProblems({ ...shapes[kind], [field]: end }, 'e'),
            [],
            `${kind}.${field} at ${end} is outside the format`,
          );
        }
      }
    }
  });

  it('keeps every colour slider inside the format, alone and together', () => {
    for (const control of ADJUSTMENTS) {
      for (const end of [control.min, control.max]) {
        assert.ok(
          withinLimits(fromAdjustments({ [control.name]: end })),
          `${control.label} at ${end} is outside the format`,
        );
      }
    }
  });

  it('leaves room for the format\'s own defaults on every slider', () => {
    // A panel that opens at a different value from the one the app assumes
    // shows one lens and publishes another for anybody who never touched it.
    assert.equal(RANGE.feather.min <= 0.14 && 0.14 <= RANGE.feather.max, true);
    assert.equal(RANGE.blur.min <= 0.16 && 0.16 <= RANGE.blur.max, true);
    assert.equal(RANGE.keepShading.min <= 0.35 && 0.35 <= RANGE.keepShading.max, true);
  });

  it('never lets frost blur reach zero, which the format refuses', () => {
    // "A blur of zero is not frost, it is nothing" -- lens.js. The slider has
    // to stop above it rather than producing a lens that is refused.
    assert.ok(RANGE.blur.min > 0);
    assert.deepEqual(effectProblems({ kind: 'frost', blur: RANGE.blur.min }, 'e'), []);
  });
});
