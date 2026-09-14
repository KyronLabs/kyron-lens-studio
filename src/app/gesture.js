// src/app/gesture.js
//
// The arithmetic behind the handles on a selected attachment.
//
// Apart from viewport.js on purpose: that file is WebGL and a DOM canvas and
// cannot run under `node --test`, while this is the half that can be wrong in
// a way nobody notices. A sign error here turns the rotate handle the wrong
// way; a scale taken from the wrong origin makes a sticker drift sideways
// while it grows. Both look like "the tool feels off" rather than a bug.
//
// Three conventions meet here, and they do not agree:
//
//   - **Plane-local** is what these functions take. Origin at the centre of
//     the attachment, +x right, +y up, with the attachment's own rotation
//     already divided out -- which is exactly what `Object3D.worldToLocal`
//     gives for a point on the plane.
//   - **The format** measures rotation clockwise on screen. It is derived
//     from a head roll of `atan2(dy, dx)` in pixels, where +y is down.
//   - **Three** turns +z counter-clockwise, which is why viewport.js writes
//     `rotation.z = -rotation * PI / 180`.
//
// So a counter-clockwise turn in plane-local coordinates is a *decrease* in
// the format's rotation. That subtraction is the thing most likely to be
// wrong, and it has a test to itself.

/**
 * The narrowest an attachment may be dragged, in whatever units the width is
 * given in.
 *
 * This is not the design clamp `attachmentFor` deliberately refuses to apply:
 * a width of 12 pupil-gaps is absurd but it is something somebody drew, and
 * the format check is what should say so. Zero is different. A plane with no
 * width draws nothing and cannot be grabbed again, so dragging a handle
 * through the centre would lose the attachment with no way back.
 */
export const MIN_WIDTH = 1e-3;

/**
 * A corner drag, as a new width.
 *
 * Uniform, about the centre: the handle keeps the cursor's distance from the
 * middle of the artwork, so the attachment grows around its anchor point
 * rather than away from the corner that was grabbed. Aspect ratio comes from
 * the artwork and is not a thing the format stores, so there is one number.
 *
 * @param {{grab: {x: number, y: number}, at: {x: number, y: number},
 *          width: number, minimum?: number}} drag
 *   `grab` and `at` are plane-local; `width` is the width when the drag began
 * @returns {number} the new width, in the units `width` was given in
 */
export function widthFromDrag({ grab, at, width, minimum = MIN_WIDTH }) {
  const from = Math.hypot(grab.x, grab.y);
  const to = Math.hypot(at.x, at.y);
  // Grabbing the exact centre has no direction to scale along, and a ray that
  // misses the plane entirely -- the head turned edge-on -- gives nothing to
  // measure. Both keep the width they had rather than jumping.
  if (!(from > 0) || !Number.isFinite(to)) return width;
  return Math.max(minimum, width * (to / from));
}

/**
 * A rotate drag, as a new rotation in the format's degrees.
 *
 * @param {{grab: {x: number, y: number}, at: {x: number, y: number},
 *          rotation: number}} drag
 * @returns {number} degrees, clockwise on screen, normalised to (-180, 180]
 */
export function rotationFromDrag({ grab, at, rotation }) {
  if (!(Math.hypot(grab.x, grab.y) > 0)) return rotation;
  if (!(Math.hypot(at.x, at.y) > 0)) return rotation;
  if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) return rotation;

  const turned =
    Math.atan2(at.y, at.x) - Math.atan2(grab.y, grab.x);
  // Minus, per the note at the top: counter-clockwise in the plane is
  // anti-clockwise on screen, and the format counts the other way.
  return normalise(rotation - (turned * 180) / Math.PI);
}

/**
 * Degrees into (-180, 180].
 *
 * The format accepts +/-360, so 270 and -90 are both legal and describe the
 * same picture. Keeping one of them means a diff after a rotate says what
 * actually changed.
 */
export function normalise(degrees) {
  if (!Number.isFinite(degrees)) return 0;
  let value = degrees % 360;
  if (value > 180) value -= 360;
  if (value <= -180) value += 360;
  // `+ 0` so a rotation that comes back to nothing is 0 rather than -0.
  return value + 0;
}

/**
 * Where the handles sit on an attachment, in plane-local units.
 *
 * Four corners to resize by, and one above the top edge to turn by. The
 * rotate handle is outside the artwork because it has to be grabbable on an
 * attachment small enough that the corners already crowd each other.
 *
 * @param {number} width  the plane's width in scene units
 * @param {number} height its height
 * @param {number} reach  how far above the top edge the rotate handle sits
 */
export function handlePositions(width, height, reach) {
  const x = width / 2;
  const y = height / 2;
  return {
    resize: [
      { name: 'nw', x: -x, y: y },
      { name: 'ne', x: x, y: y },
      { name: 'se', x: x, y: -y },
      { name: 'sw', x: -x, y: -y },
    ],
    rotate: { x: 0, y: y + reach },
  };
}
