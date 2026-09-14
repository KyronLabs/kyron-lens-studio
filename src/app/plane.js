// src/app/plane.js
//
// The plane a handle drag runs in.
//
// Apart from viewport.js for the same reason gesture.js is: this is three.js
// arithmetic with no renderer in it, so it runs under `node --test`, and it
// holds the one piece of the handles whose failure is not obvious.
//
// Writing a new width or rotation rebuilds the sprite from the lens, so by
// the second frame of a drag the plane on screen is not the one that was
// grabbed. viewport.js therefore captures the frame once, when the drag
// begins, and measures every move against that.
//
// It is worth saying what that does and does not buy, because the obvious
// story is wrong. Re-reading the frame each move does **not** break the
// rotate: the plane's own rotation appears on both sides of the arithmetic
// and cancels, so both ways land on the same angle -- there is a test that
// runs them side by side and asserts they agree. Nor does it matter for a
// resize, which measures a distance that the rotation does not change and an
// origin that a resize does not move.
//
// The capture is kept because the drag is defined against where it started:
// one fixed reference, no dependence on the app writing back exactly the
// number the viewport computed, and nothing to re-derive about why a value
// that feeds back into its own input is stable.

import * as THREE from './vendor/three.module.js';

/**
 * How square-on the ray has to be to the plane for the point where they meet
 * to mean anything: the cosine of the angle between the ray and the plane's
 * normal, so 1 is face-on and 0 is edge-on.
 *
 * three's `intersectPlane` refuses only a ray that is *exactly* parallel, and
 * exactly is not a thing floating point does. Measured, for a cursor one unit
 * off the centre of the attachment:
 *
 *   head turned   incidence   the point, in the plane's own units
 *   52 deg        0.62        1.6
 *   80 deg        0.17        5.8
 *   88 deg        0.035       29
 *   89.9 deg      0.0018      573
 *   90 deg        2.2e-16     4.5e15
 *
 * That last one is what three hands back rather than refusing, and a corner
 * drag turns it straight into a width of 4.5e15 pupil-gaps. Even the 89.9
 * case is a lens nobody drew.
 *
 * 0.1 is about 84 degrees off square, and keeps the worst case around ten
 * times the cursor's own movement. The head's up-and-down turn is clamped to
 * 0.9 radians -- 52 degrees, the first row above -- so this only ever bites
 * on the left-and-right turn, which is not clamped because there is a reason
 * to look at the side of the face.
 */
const MIN_INCIDENCE = 0.1;

/**
 * The plane a mesh lies in, and the transform back into its own coordinates.
 *
 * Take this once, when a drag begins, and keep it for the whole drag.
 */
export function frameOf(mesh) {
  mesh.updateMatrixWorld();
  return {
    surface: new THREE.Plane().setFromNormalAndCoplanarPoint(
      new THREE.Vector3(0, 0, 1).transformDirection(mesh.matrixWorld),
      new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld),
    ),
    inverse: new THREE.Matrix4().copy(mesh.matrixWorld).invert(),
  };
}

/**
 * Where a ray meets that plane, in the plane's own coordinates.
 *
 * Unbounded: a corner drag leaves the artwork immediately, so intersecting
 * the mesh itself would stop working the moment the drag began.
 *
 * Null means the ray is parallel to the plane -- the head turned edge-on
 * mid-drag. The caller keeps the value it had rather than writing a NaN into
 * the lens.
 */
export function localIn(frame, ray) {
  if (Math.abs(frame.surface.normal.dot(ray.direction)) < MIN_INCIDENCE) {
    return null;
  }
  const point = new THREE.Vector3();
  if (!ray.intersectPlane(frame.surface, point)) return null;
  return point.applyMatrix4(frame.inverse);
}
