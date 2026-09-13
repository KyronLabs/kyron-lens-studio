// src/app/units.js
//
// Pupil-gaps, in units somebody can picture.
//
// The lens format measures everything in multiples of the distance between
// the two pupils, and that is the right choice -- it is what makes a lens
// correct at any distance from the camera, on any face, at any resolution.
// It is also a number nobody has an intuition for. "Width 2.6" is not a size.
//
// So the inspector shows the gap figure, which is what gets published, and
// next to it the same quantity in millimetres on an average adult face. The
// millimetres are an illustration and are labelled as one: a lens is not
// published in millimetres and does not become wrong on a face with a
// different interpupillary distance.

/**
 * The interpupillary distance this converts against, in millimetres.
 *
 * 63mm is the usual adult average quoted in optometry, and the same figure
 * `SkinSampler` in the app reasons with. Adults run from about 52 to 78, so
 * treat anything here as within a fifth either way -- which is fine for
 * "is this hat about the size of a hat".
 */
export const GAP_MM = 63;

/** A width in pupil-gaps, as millimetres on an average face. */
export function gapsToMm(gaps) {
  return gaps * GAP_MM;
}

/** Millimetres on an average face, as pupil-gaps. */
export function mmToGaps(mm) {
  return mm / GAP_MM;
}

/**
 * A number for a label: enough places to be useful, no more.
 *
 * Trailing zeros are dropped, because "2.60" in a field somebody is about to
 * type over reads as a decimal they have to match.
 */
export function show(value, places = 2) {
  if (!Number.isFinite(value)) return '—';
  return String(Number(value.toFixed(places)));
}

/** A width, with the illustration beside it. */
export function describeWidth(gaps) {
  return `${show(gaps)} gaps · about ${show(gapsToMm(gaps), 0)}mm`;
}

/**
 * Where a control's ends are, per field of the lens format.
 *
 * Taken from the format rather than from taste: a slider that can reach a
 * value the app refuses is a control that builds an unpublishable lens and
 * says nothing about which one did it. `lens.js` is the authority; this is
 * the same limits in the shape a range input wants.
 */
export const RANGE = Object.freeze({
  width: { min: 0.05, max: 12, step: 0.05 },
  offsetX: { min: -8, max: 8, step: 0.05 },
  offsetY: { min: -8, max: 8, step: 0.05 },
  rotation: { min: -180, max: 180, step: 1 },
  feather: { min: 0, max: 2, step: 0.01 },
  keepShading: { min: 0, max: 1, step: 0.01 },
  blur: { min: 0.01, max: 2, step: 0.01 },
  desaturate: { min: 0, max: 1, step: 0.01 },
  lift: { min: 0, max: 1, step: 0.01 },
});

/**
 * The adjustment sliders, with the ends checked against the format.
 *
 * Every combination of these ends produces a matrix inside the format's
 * limits -- there is a test for exactly that in test/matrix.test.js, because
 * an end that goes one step too far is only discovered at publish time.
 */
export const ADJUSTMENTS = Object.freeze([
  { name: 'exposure', label: 'Exposure', min: -3, max: 3, step: 0.05, rest: 0, unit: 'stops' },
  { name: 'contrast', label: 'Contrast', min: 0, max: 3, step: 0.01, rest: 1 },
  { name: 'saturation', label: 'Saturation', min: 0, max: 2, step: 0.01, rest: 1 },
  { name: 'temperature', label: 'Temperature', min: -1, max: 1, step: 0.01, rest: 0, unit: 'cool · warm' },
  { name: 'tint', label: 'Tint', min: -1, max: 1, step: 0.01, rest: 0, unit: 'green · magenta' },
  { name: 'hue', label: 'Hue', min: -180, max: 180, step: 1, rest: 0, unit: '°' },
  { name: 'brightness', label: 'Brightness', min: -1, max: 1, step: 0.01, rest: 0 },
  { name: 'sepia', label: 'Sepia', min: 0, max: 1, step: 0.01, rest: 0 },
  { name: 'invert', label: 'Invert', min: 0, max: 1, step: 0.01, rest: 0 },
]);
