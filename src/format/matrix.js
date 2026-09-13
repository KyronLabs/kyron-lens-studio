// src/format/matrix.js
//
// Twenty numbers, made usable.
//
// A colour lens is a 4x5 matrix applied to every pixel. Flutter's
// `ColorFilter.matrix` -- which is what the app builds from `lens.matrix`,
// see `Lens.filter` -- reads it row-major over unpremultiplied RGBA in 0..255:
//
//     R' = m[0]*R  + m[1]*G  + m[2]*B  + m[3]*A  + m[4]
//     G' = m[5]*R  + m[6]*G  + m[7]*B  + m[8]*A  + m[9]
//     B' = m[10]*R + m[11]*G + m[12]*B + m[13]*A + m[14]
//     A' = m[15]*R + m[16]*G + m[17]*B + m[18]*A + m[19]
//
// The fifth column is an offset in the same 0..255 units, which is why the
// format allows +/-255 there and only +/-8 in the other four.
//
// Nobody thinks in those numbers. People think in "warmer", "more contrast",
// "less colour". This module is the translation: each named adjustment is a
// matrix, adjustments compose by multiplication, and what comes out the far
// end is the twenty numbers that get published.
//
// It is deliberately one-directional. Going the other way -- matrix back to
// sliders -- has no answer: the same matrix can be reached by many different
// settings, and offering sliders that claim to describe a hand-written matrix
// would move it the moment anybody touched one. The studio keeps the
// adjustments alongside the matrix in its own project file and shows the raw
// numbers when it has nothing else, which is honest about which it has.

/** Changes nothing. */
export const IDENTITY = Object.freeze([
  1, 0, 0, 0, 0,
  0, 1, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 1, 0,
]);

/** Rec. 709 luminance, the weights a saturation matrix is built from. */
const LR = 0.2126;
const LG = 0.7152;
const LB = 0.0722;

/** Mid grey, in the units the offsets are in. */
const MID = 127.5;

/**
 * Two matrices as one: apply `first`, then `second`.
 *
 * Written in the order a reader means it, which is the reverse of how the
 * multiplication goes -- so this takes them in pipeline order and reverses
 * them itself rather than leaving that to every caller.
 */
export function compose(first, second) {
  const out = new Array(20).fill(0);
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 5; column++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += second[row * 5 + k] * first[k * 5 + column];
      }
      // The fifth column is an offset rather than a coefficient, so the
      // second matrix's own offset is added to the transformed one instead
      // of being multiplied through.
      if (column === 4) sum += second[row * 5 + 4];
      out[row * 5 + column] = sum;
    }
  }
  return out;
}

/** Every matrix in the list, applied in order. */
export function composeAll(matrices) {
  return matrices.reduce((carried, next) => compose(carried, next), [...IDENTITY]);
}

/**
 * One pixel through a matrix. `pixel` and the result are [r, g, b, a] in
 * 0..255.
 *
 * This is what the previews are drawn with, and what the tests check against:
 * a matrix is only right if the pixels it produces are right.
 */
export function apply(matrix, pixel) {
  const [r, g, b, a] = pixel;
  const out = new Array(4);
  for (let row = 0; row < 4; row++) {
    const at = row * 5;
    out[row] = clamp(
      matrix[at] * r +
        matrix[at + 1] * g +
        matrix[at + 2] * b +
        matrix[at + 3] * a +
        matrix[at + 4],
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// The adjustments
// ---------------------------------------------------------------------------

/**
 * Stops of light. +1 is twice as bright.
 *
 * In stops rather than in percent because that is how exposure behaves and
 * how anybody who has held a camera thinks about it.
 */
export function exposure(stops) {
  const gain = 2 ** stops;
  return scale(gain, gain, gain);
}

/** A flat lift or drop, -1 to 1, where 1 is full white. */
export function brightness(amount) {
  const offset = amount * 255;
  return [
    1, 0, 0, 0, offset,
    0, 1, 0, 0, offset,
    0, 0, 1, 0, offset,
    0, 0, 0, 1, 0,
  ];
}

/**
 * Contrast about mid grey. 1 changes nothing, 0 is flat grey, 2 is hard.
 *
 * About mid grey rather than about black, which is the difference between
 * "more contrast" and "brighter and more contrast".
 */
export function contrast(amount) {
  const shift = MID * (1 - amount);
  return [
    amount, 0, 0, 0, shift,
    0, amount, 0, 0, shift,
    0, 0, amount, 0, shift,
    0, 0, 0, 1, 0,
  ];
}

/** Colour strength. 0 is grey, 1 changes nothing, over 1 pushes. */
export function saturation(amount) {
  const inverse = 1 - amount;
  const r = inverse * LR;
  const g = inverse * LG;
  const b = inverse * LB;
  return [
    r + amount, g, b, 0, 0,
    r, g + amount, b, 0, 0,
    r, g, b + amount, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

/**
 * Warm or cool, -1 to 1. Positive is warmer.
 *
 * Not a real colour temperature: that needs the white point the picture was
 * shot at, and a lens has no idea. This is the gain on the red and blue ends
 * that people mean by the word, at a strength where the whole range is usable
 * rather than the middle third of it.
 */
export function temperature(amount) {
  return scale(1 + amount * 0.35, 1, 1 - amount * 0.35);
}

/** Green to magenta, -1 to 1. Positive is magenta, matching every other tool. */
export function tint(amount) {
  return scale(1 + amount * 0.2, 1 - amount * 0.25, 1 + amount * 0.2);
}

/**
 * Turns the colour wheel, in degrees.
 *
 * The matrix from the SVG filter specification's `feColorMatrix
 * type="hueRotate"`, which is the one every other tool uses -- so a lens
 * turned 30 degrees here looks like a lens turned 30 degrees anywhere else.
 */
export function hueRotate(degrees) {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [
    LR + cos * (1 - LR) + sin * -LR,
    LG + cos * -LG + sin * -LG,
    LB + cos * -LB + sin * (1 - LB),
    0, 0,

    LR + cos * -LR + sin * 0.143,
    LG + cos * (1 - LG) + sin * 0.14,
    LB + cos * -LB + sin * -0.283,
    0, 0,

    LR + cos * -LR + sin * -(1 - LR),
    LG + cos * -LG + sin * LG,
    LB + cos * (1 - LB) + sin * LB,
    0, 0,

    0, 0, 0, 1, 0,
  ];
}

/** The classic sepia, at `amount` from 0 to 1. */
export function sepia(amount) {
  const full = [
    0.393, 0.769, 0.189, 0, 0,
    0.349, 0.686, 0.168, 0, 0,
    0.272, 0.534, 0.131, 0, 0,
    0, 0, 0, 1, 0,
  ];
  return mix(IDENTITY, full, amount);
}

/** Negative, at `amount` from 0 to 1. */
export function invert(amount) {
  const full = [
    -1, 0, 0, 0, 255,
    0, -1, 0, 0, 255,
    0, 0, -1, 0, 255,
    0, 0, 0, 1, 0,
  ];
  return mix(IDENTITY, full, amount);
}

/**
 * A wash of one colour over everything, at `amount` from 0 to 1.
 *
 * `colour` is [r, g, b] in 0..255. Not a multiply: this is the "tinted
 * photograph" look, where the picture keeps its own shape and the colour sits
 * over it.
 */
export function wash(colour, amount) {
  const keep = 1 - amount;
  return [
    keep, 0, 0, 0, colour[0] * amount,
    0, keep, 0, 0, colour[1] * amount,
    0, 0, keep, 0, colour[2] * amount,
    0, 0, 0, 1, 0,
  ];
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/** What every control sits at when it is doing nothing. */
export const NEUTRAL = Object.freeze({
  exposure: 0,
  brightness: 0,
  contrast: 1,
  saturation: 1,
  temperature: 0,
  tint: 0,
  hue: 0,
  sepia: 0,
  invert: 0,
  wash: null,
  washAmount: 0,
});

/**
 * The order the controls are applied in.
 *
 * It matters for 31 of the 45 pairs of controls here -- exposure then
 * contrast is not contrast then exposure, warming then turning the wheel is
 * not turning the wheel then warming -- and a studio where the same settings
 * give a different answer depending on which slider was touched last is
 * unusable. So the order is fixed here rather than following whatever order
 * an object's keys happen to be in.
 *
 * It is the order a photo pipeline uses: get the light right, then the
 * colour, then the stylising.
 *
 * (The other 14 pairs genuinely do commute, which is not obvious and is worth
 * knowing before writing a test that assumes otherwise. Saturation leaves
 * neutral colours alone and contrast is a scalar plus a neutral offset, so
 * those two come out the same either way.)
 */
export const ORDER = Object.freeze([
  'exposure',
  'brightness',
  'contrast',
  'saturation',
  'temperature',
  'tint',
  'hue',
  'sepia',
  'invert',
  'wash',
]);

/** The twenty numbers for a panel of adjustments. */
export function fromAdjustments(adjustments = {}) {
  const settings = { ...NEUTRAL, ...adjustments };
  const steps = [];

  for (const name of ORDER) {
    switch (name) {
      case 'exposure':
        if (settings.exposure) steps.push(exposure(settings.exposure));
        break;
      case 'brightness':
        if (settings.brightness) steps.push(brightness(settings.brightness));
        break;
      case 'contrast':
        if (settings.contrast !== 1) steps.push(contrast(settings.contrast));
        break;
      case 'saturation':
        if (settings.saturation !== 1) steps.push(saturation(settings.saturation));
        break;
      case 'temperature':
        if (settings.temperature) steps.push(temperature(settings.temperature));
        break;
      case 'tint':
        if (settings.tint) steps.push(tint(settings.tint));
        break;
      case 'hue':
        if (settings.hue) steps.push(hueRotate(settings.hue));
        break;
      case 'sepia':
        if (settings.sepia) steps.push(sepia(settings.sepia));
        break;
      case 'invert':
        if (settings.invert) steps.push(invert(settings.invert));
        break;
      case 'wash':
        if (settings.wash && settings.washAmount) {
          steps.push(wash(settings.wash, settings.washAmount));
        }
        break;
    }
  }

  return round(composeAll(steps));
}

/**
 * Whether a matrix is inside what the format will accept.
 *
 * `lens.js` answers this properly, with the words the app would use. This is
 * the cheap version the sliders ask on every drag, so a control can be stopped
 * at the edge instead of letting somebody build a lens that is refused at
 * publish time with no idea which slider did it.
 */
export function withinLimits(matrix) {
  return matrix.every((value, index) => {
    if (!Number.isFinite(value)) return false;
    const isOffset = index % 5 === 4;
    return Math.abs(value) <= (isOffset ? 255 : 8);
  });
}

/** Whether two matrices are the same to the precision that gets published. */
export function same(a, b, places = 4) {
  const tolerance = 0.5 * 10 ** -places;
  return a.length === b.length &&
    a.every((value, index) => Math.abs(value - b[index]) <= tolerance);
}

/** Whether this matrix leaves every pixel alone. */
export function isIdentity(matrix) {
  return same(matrix, IDENTITY);
}

function scale(r, g, b) {
  return [
    r, 0, 0, 0, 0,
    0, g, 0, 0, 0,
    0, 0, b, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

function mix(from, to, amount) {
  const t = Math.min(1, Math.max(0, amount));
  return from.map((value, index) => value + (to[index] - value) * t);
}

function clamp(value) {
  return Math.min(255, Math.max(0, value));
}

/**
 * To four places, which is what the catalogue is written at.
 *
 * Rounded here rather than at the point of writing the file so that what the
 * preview is drawn with and what gets published are the same numbers.
 */
function round(matrix) {
  // `+ 0` turns -0 into 0: a matrix full of "-0" reads as a bug in review.
  return matrix.map((value) => Math.round(value * 10000) / 10000 + 0);
}
