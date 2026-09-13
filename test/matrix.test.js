import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  IDENTITY,
  NEUTRAL,
  ORDER,
  apply,
  brightness,
  compose,
  composeAll,
  contrast,
  exposure,
  fromAdjustments,
  hueRotate,
  invert,
  isIdentity,
  same,
  saturation,
  sepia,
  temperature,
  tint,
  wash,
  withinLimits,
} from '../src/format/matrix.js';

/// The twenty numbers a colour lens is, and the controls that produce them.
///
/// Everything here is checked on pixels rather than on coefficients. A matrix
/// is only right if what it does to a red pixel is right, and a test that
/// compares one hand-written matrix to another hand-written matrix proves
/// only that they were typed the same way twice.

const RED = [255, 0, 0, 255];
const GREY = [127.5, 127.5, 127.5, 255];
const WHITE = [255, 255, 255, 255];
const BLACK = [0, 0, 0, 255];
const SKIN = [198, 142, 110, 255];

/// Rec. 709 luminance, which is what saturation collapses towards.
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const near = (actual, expected, tolerance = 0.5) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} is not within ${tolerance} of ${expected}`,
  );

const nearPixel = (actual, expected, tolerance = 0.5) => {
  for (let i = 0; i < 4; i++) near(actual[i], expected[i], tolerance);
};

describe('the matrix itself', () => {
  it('leaves every pixel alone when it is the identity', () => {
    for (const pixel of [RED, GREY, WHITE, BLACK, SKIN]) {
      assert.deepEqual(apply(IDENTITY, pixel), pixel);
    }
  });

  it('composes in the order a reader means it', () => {
    // The whole reason `compose` exists rather than a bare matrix multiply:
    // composing must mean "this, then that", and matrix multiplication is
    // written the other way round. If this is backwards, every preview in the
    // studio is a different lens from the one it publishes.
    //
    // On a pixel dark enough that nothing clamps on the way. Step by step is
    // only the same as composed while every intermediate stays in range --
    // which is an argument for composing rather than stepping, since the app
    // applies one matrix once and never sees an intermediate at all.
    const dark = [80, 60, 45, 255];
    const first = exposure(1);
    const second = saturation(0);

    nearPixel(
      apply(compose(first, second), dark),
      apply(second, apply(first, dark)),
    );
  });

  it('is not commutative, and the test would be worthless if it were', () => {
    // Warming then turning the wheel is not turning the wheel then warming:
    // a rotation and an uneven scale do not commute. If this came out equal,
    // the ordering test above would pass for a backwards `compose`.
    //
    // Picked carefully. 14 of the 45 pairs of controls here genuinely *do*
    // commute -- saturation leaves neutral colours alone and contrast is a
    // scalar plus a neutral offset, so those two agree either way, and so do
    // contrast and invert. This test was first written on contrast and
    // saturation and failed, correctly.
    const a = compose(temperature(0.5), hueRotate(40));
    const b = compose(hueRotate(40), temperature(0.5));
    assert.ok(!same(a, b), 'temperature and hue happen to commute');
  });

  it('carries offsets through a composition rather than multiplying them', () => {
    // A lift of +20 followed by a doubling is +40, not +20. Getting this
    // wrong is invisible on any matrix without an offset -- which is most of
    // them -- and wrong on every one with a contrast or a wash in it.
    const lift = brightness(20 / 255);
    const double = exposure(1);

    const composed = compose(lift, double);
    near(apply(composed, BLACK)[0], 40);
    near(apply(composed, BLACK)[0], apply(double, apply(lift, BLACK))[0]);
  });

  it('composes a list the same way as one at a time', () => {
    const steps = [exposure(0.5), contrast(1.3), saturation(0.7)];
    const listed = composeAll(steps);
    const folded = steps.reduce((carried, step) => compose(carried, step), [
      ...IDENTITY,
    ]);
    assert.ok(same(listed, folded));
  });
});

describe('the adjustments', () => {
  it('measures exposure in stops, so +1 is twice the light', () => {
    near(apply(exposure(1), [60, 60, 60, 255])[0], 120);
    near(apply(exposure(-1), [120, 120, 120, 255])[0], 60);
    assert.ok(isIdentity(exposure(0)));
  });

  it('pivots contrast on mid grey rather than on black', () => {
    // The difference between "more contrast" and "darker, with more
    // contrast". Mid grey has to come out of a contrast change unmoved.
    for (const amount of [0.4, 1.5, 2]) {
      nearPixel(apply(contrast(amount), GREY), GREY);
    }
    // And it does move everything else, in the right direction.
    assert.ok(apply(contrast(1.5), [60, 60, 60, 255])[0] < 60);
    assert.ok(apply(contrast(1.5), [200, 200, 200, 255])[0] > 200);
  });

  it('collapses saturation onto the luminance of the pixel', () => {
    for (const pixel of [RED, SKIN, [30, 200, 90, 255]]) {
      const grey = apply(saturation(0), pixel);
      near(grey[0], luminance(pixel));
      assert.equal(grey[0], grey[1]);
      assert.equal(grey[1], grey[2]);
    }
  });

  it('leaves a grey pixel grey however it is turned', () => {
    // Hue, temperature and tint are all colour moves, and grey has no colour
    // to move. Temperature and tint are gains rather than rotations, so they
    // are allowed to change grey's brightness -- but not its neutrality.
    const turned = apply(hueRotate(137), GREY);
    near(turned[0], turned[1], 1.5);
    near(turned[1], turned[2], 1.5);
  });

  it('comes back to where it started after a full turn of the wheel', () => {
    nearPixel(apply(hueRotate(360), SKIN), SKIN, 1);
    nearPixel(apply(hueRotate(0), SKIN), SKIN, 0.001);
  });

  it('warms towards red and cools towards blue', () => {
    const warm = apply(temperature(0.5), SKIN);
    const cool = apply(temperature(-0.5), SKIN);

    assert.ok(warm[0] > SKIN[0], 'warm did not raise red');
    assert.ok(warm[2] < SKIN[2], 'warm did not lower blue');
    assert.ok(cool[0] < SKIN[0], 'cool did not lower red');
    assert.ok(cool[2] > SKIN[2], 'cool did not raise blue');
  });

  it('tints towards magenta and towards green, the way every other tool does',
    () => {
      const magenta = apply(tint(0.6), GREY);
      const green = apply(tint(-0.6), GREY);

      assert.ok(magenta[1] < magenta[0], 'magenta did not pull green down');
      assert.ok(green[1] > green[0], 'green did not push green up');
    });

  it('keeps a photograph recognisable under sepia, and is a ramp', () => {
    const half = apply(sepia(0.5), SKIN);
    const full = apply(sepia(1), SKIN);

    // Halfway is halfway, not a different look.
    for (let i = 0; i < 3; i++) near(half[i], (SKIN[i] + full[i]) / 2, 1);
    assert.ok(full[0] > full[2], 'sepia is not warm');
    nearPixel(apply(sepia(0), SKIN), SKIN, 0.001);
  });

  it('inverts to the complement, and halfway lands on flat grey', () => {
    nearPixel(apply(invert(1), BLACK), WHITE);
    nearPixel(apply(invert(1), RED), [0, 255, 255, 255]);
    // Half an inversion is every channel pulled to the middle.
    const half = apply(invert(0.5), RED);
    near(half[0], 127.5);
    near(half[1], 127.5);
  });

  it('washes a colour over a picture without flattening it', () => {
    const washed = apply(wash([0, 128, 255], 0.4), SKIN);
    // Pulled towards the wash...
    assert.ok(washed[2] > SKIN[2]);
    // ...but the picture is still underneath it, so a bright pixel is still
    // brighter than a dark one.
    const dark = apply(wash([0, 128, 255], 0.4), [40, 40, 40, 255]);
    assert.ok(washed[0] > dark[0]);
  });

  it('never touches alpha', () => {
    // A lens that changes alpha punches a hole in somebody's photograph. The
    // format allows it -- the fourth row is twenty numbers like any other --
    // and nothing here should ever produce it.
    for (const matrix of [
      exposure(2), contrast(2), saturation(0), hueRotate(90),
      sepia(1), invert(1), wash([255, 0, 0], 1), temperature(1), tint(1),
      brightness(0.5),
    ]) {
      assert.deepEqual(matrix.slice(15), [0, 0, 0, 1, 0]);
    }
  });
});

describe('the panel', () => {
  it('does nothing at all when every control is at rest', () => {
    assert.ok(isIdentity(fromAdjustments({})));
    assert.ok(isIdentity(fromAdjustments(NEUTRAL)));
  });

  it('applies the controls in a fixed order, whatever order they are given in',
    () => {
      // The object's key order must not decide what the lens looks like. Two
      // people describing the same lens have to get the same twenty numbers.
      const forwards = fromAdjustments({ contrast: 1.4, saturation: 0.6, exposure: 0.3 });
      const backwards = fromAdjustments({ exposure: 0.3, saturation: 0.6, contrast: 1.4 });
      assert.deepEqual(forwards, backwards);
    });

  it('agrees with running the same controls by hand, in ORDER', () => {
    const settings = {
      exposure: 0.4,
      contrast: 1.25,
      saturation: 0.8,
      temperature: 0.3,
      hue: 15,
    };
    const byHand = composeAll([
      exposure(settings.exposure),
      contrast(settings.contrast),
      saturation(settings.saturation),
      temperature(settings.temperature),
      hueRotate(settings.hue),
    ]);
    // Rounded the same way, because what is published is the rounded one.
    assert.ok(same(fromAdjustments(settings), byHand, 3));
  });

  it('names every control it applies', () => {
    // A control added to NEUTRAL and forgotten in ORDER is a slider that does
    // nothing, silently.
    for (const key of Object.keys(NEUTRAL)) {
      if (key === 'washAmount') continue;
      assert.ok(ORDER.includes(key), `${key} is not in ORDER`);
    }
  });

  it('publishes numbers at the precision the catalogue is written at', () => {
    const matrix = fromAdjustments({ saturation: 0.333, hue: 27 });
    for (const value of matrix) {
      assert.equal(value, Math.round(value * 10000) / 10000);
      assert.ok(!Object.is(value, -0), 'a -0 got into the matrix');
    }
  });

  it('stays inside the format across the whole range of every control', () => {
    // The sliders have ends, and every combination of those ends has to
    // produce a lens the app will draw. A matrix over the limits is refused
    // at publish time with nothing to say which control did it.
    const extremes = {
      exposure: [-3, 3],
      brightness: [-1, 1],
      contrast: [0, 3],
      saturation: [0, 2],
      temperature: [-1, 1],
      tint: [-1, 1],
      hue: [-180, 180],
      sepia: [0, 1],
      invert: [0, 1],
    };
    for (const [name, ends] of Object.entries(extremes)) {
      for (const end of ends) {
        const matrix = fromAdjustments({ [name]: end });
        assert.ok(withinLimits(matrix), `${name} at ${end} is outside the format`);
      }
    }
  });

  it('catches a matrix the format would refuse', () => {
    assert.ok(!withinLimits(fromAdjustments({ exposure: 6 })));
    assert.ok(!withinLimits([...IDENTITY.slice(0, 4), 300, ...IDENTITY.slice(5)]));
    assert.ok(!withinLimits(IDENTITY.map(() => Number.NaN)));
  });
});
